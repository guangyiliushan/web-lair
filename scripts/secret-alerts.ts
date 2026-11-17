/**
 * Secret-failure alert timer: reads the audit rows the app writes on key
 * failures, applies the three rules in
 * `src/lib/server/secrets/alert-rules.ts`, and POSTs one message per firing
 * rule to `ALERT_WEBHOOK_URL` (the same target as the systemd `OnFailure`
 * unit). Dedupe state lives in `$DATA_DIR/secret-alerts-state.json`, so the
 * 5-minute timer does not repeat an alert every tick.
 *
 * Usage: `node --env-file-if-exists=.env scripts/secret-alerts.ts [--dry-run]`.
 * Exit codes: 0 nothing to do / delivered, 1 a POST failed, 2 config; the
 * audit rows are the durable record, this script only notifies.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import {
	evaluateSecretAlerts,
	type ActivityRow,
	type UsageRow
} from '../src/lib/server/secrets/alert-rules.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const DEDUPE_MS = 5 * 60_000;

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[secret-alerts] DATABASE_URL is not set');
	process.exit(2);
}
const alertUrl = (process.env.ALERT_WEBHOOK_URL ?? '').trim();
const dataDir = (process.env.DATA_DIR ?? './data').trim();
const statePath = join(dataDir, 'secret-alerts-state.json');

type State = Record<string, string>;

async function readState(): Promise<State> {
	try {
		const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const out: State = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === 'string') out[key] = value;
			}
			return out;
		}
	} catch {
		// Missing or corrupt state must not suppress an alert.
	}
	return {};
}

async function writeState(state: State): Promise<void> {
	const temp = `${statePath}.tmp`;
	await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
	await rename(temp, statePath);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
try {
	const activityRows = await client<
		{
			event: string;
			created_at: Date;
			actor_id: string | null;
			payload: Record<string, unknown> | null;
		}[]
	>`
		select event, created_at, actor_id, payload
		from activities
		where event in ('ai.key_decrypt_failed', 'ai.key_missing', 'ai.key_denied')
			and created_at > now() - interval '10 minutes'
		order by created_at desc
		limit 1000
	`;
	const usageRows = await client<{ provider: string; status: string; created_at: Date }[]>`
		select provider, status, created_at
		from ai_usage
		where created_at > now() - interval '10 minutes'
		limit 5000
	`;

	const activities: ActivityRow[] = activityRows.map((row) => ({
		event: row.event,
		createdAt: row.created_at,
		actorId: row.actor_id,
		payload: row.payload
	}));
	const usage: UsageRow[] = usageRows.map((row) => ({
		provider: row.provider,
		status: row.status,
		createdAt: row.created_at
	}));

	const alerts = evaluateSecretAlerts({ activities, usage, now: new Date() });
	if (alerts.length === 0) {
		console.log('[secret-alerts] no firing rules');
		process.exit(0);
	}

	const state = await readState();
	const now = Date.now();
	const fresh = alerts.filter((alert) => {
		const last = state[alert.key];
		return !last || now - new Date(last).getTime() > DEDUPE_MS;
	});
	for (const alert of alerts) {
		const suppressed = fresh.includes(alert) ? '' : ' (deduped)';
		console.log(`[secret-alerts] ${alert.rule}: ${alert.message}${suppressed}`);
		if (DRY_RUN) continue;
		if (!alertUrl) continue;
		try {
			const response = await fetch(alertUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					text: `[web-lair] ${alert.message}`,
					rule: alert.rule,
					subject: alert.subject,
					count: alert.count
				}),
				signal: AbortSignal.timeout(10_000)
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			state[alert.key] = new Date(now).toISOString();
		} catch (error) {
			console.error(
				`[secret-alerts] delivery failed for ${alert.key}:`,
				error instanceof Error ? error.message : error
			);
			process.exitCode = 1;
		}
	}
	if (!DRY_RUN) await writeState(state);
	if (!alertUrl && !DRY_RUN) {
		console.warn('[secret-alerts] ALERT_WEBHOOK_URL is empty; alerts were only logged');
	}
} finally {
	await client.end({ timeout: 5 });
}

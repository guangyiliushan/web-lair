/**
 * Alert rules for secret failures (W2.5 / decision A3).
 *
 * Pure functions over audit rows so the timer script and the tests agree on
 * what "fires" means. The script (`scripts/secret-alerts.ts`) owns the queries,
 * the dedupe file and the POST to `ALERT_WEBHOOK_URL`.
 *
 * Three rules, exactly as decided:
 *   1. `ai.key_decrypt_failed` - any occurrence in the last 5 minutes.
 *   2. `ai.key_missing` - >= 3 for one provider in 10 minutes AND zero
 *      successful AI calls for that provider in the same window (a provider
 *      that is simply unconfigured between calls is not an outage).
 *   3. `ai.key_denied` - >= 3 for one actor in 10 minutes.
 */

export type SecretAlertRule = 'decrypt_failed' | 'missing' | 'denied';

export interface ActivityRow {
	event: string;
	createdAt: Date;
	actorId: string | null;
	payload: Record<string, unknown> | null;
}

export interface UsageRow {
	provider: string;
	status: string;
	createdAt: Date;
}

export interface SecretAlert {
	rule: SecretAlertRule;
	/** Stable dedupe key: `${rule}:${subject}`. */
	key: string;
	subject: string;
	count: number;
	message: string;
}

export const WINDOW_DECRYPT_MS = 5 * 60_000;
export const WINDOW_MISSING_MS = 10 * 60_000;
export const WINDOW_DENIED_MS = 10 * 60_000;
export const MISSING_THRESHOLD = 3;
export const DENIED_THRESHOLD = 3;

function within(row: { createdAt: Date }, now: Date, windowMs: number): boolean {
	return now.getTime() - row.createdAt.getTime() <= windowMs;
}

function providerOf(row: ActivityRow): string | null {
	const value = row.payload?.provider;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export function evaluateSecretAlerts(input: {
	activities: readonly ActivityRow[];
	usage: readonly UsageRow[];
	now: Date;
}): SecretAlert[] {
	const { activities, usage, now } = input;
	const alerts: SecretAlert[] = [];

	// Rule 1: one decrypt failure is enough. A wrong keyring or a moved
	// ciphertext is never routine. The webhook delivery path uses the same
	// keyring and emits its own event family.
	const decryptFailures = activities.filter(
		(row) =>
			(row.event === 'ai.key_decrypt_failed' || row.event === 'webhook.key_decrypt_failed') &&
			within(row, now, WINDOW_DECRYPT_MS)
	);
	if (decryptFailures.length > 0) {
		const providers = new Set(decryptFailures.map((row) => providerOf(row) ?? 'unknown'));
		alerts.push({
			rule: 'decrypt_failed',
			key: `decrypt_failed:${[...providers].sort().join(',')}`,
			subject: [...providers].sort().join(', '),
			count: decryptFailures.length,
			message: `${decryptFailures.length} secret decryption failure(s) in 5 minutes for: ${[...providers].join(', ')}`
		});
	}

	// Rule 2: repeated missing keys with no success in the window.
	const missing = activities.filter(
		(row) => row.event === 'ai.key_missing' && within(row, now, WINDOW_MISSING_MS)
	);
	const missingByProvider = new Map<string, number>();
	for (const row of missing) {
		const provider = providerOf(row);
		if (!provider) continue;
		missingByProvider.set(provider, (missingByProvider.get(provider) ?? 0) + 1);
	}
	const successByProvider = new Set(
		usage
			.filter((row) => row.status === 'success' && within(row, now, WINDOW_MISSING_MS))
			.map((row) => row.provider)
	);
	for (const [provider, count] of missingByProvider) {
		if (count < MISSING_THRESHOLD || successByProvider.has(provider)) continue;
		alerts.push({
			rule: 'missing',
			key: `missing:${provider}`,
			subject: provider,
			count,
			message: `${count} missing-key failures for "${provider}" in 10 minutes with no successful call`
		});
	}

	// Rule 3: repeated denied attempts by one actor.
	const denied = activities.filter(
		(row) => row.event === 'ai.key_denied' && within(row, now, WINDOW_DENIED_MS)
	);
	const deniedByActor = new Map<string, number>();
	for (const row of denied) {
		const actor = row.actorId ?? 'anonymous';
		deniedByActor.set(actor, (deniedByActor.get(actor) ?? 0) + 1);
	}
	for (const [actor, count] of deniedByActor) {
		if (count < DENIED_THRESHOLD) continue;
		alerts.push({
			rule: 'denied',
			key: `denied:${actor}`,
			subject: actor,
			count,
			message: `${count} denied secret-write attempts by actor ${actor} in 10 minutes`
		});
	}

	return alerts;
}

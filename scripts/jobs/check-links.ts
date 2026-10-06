// scripts/jobs/check-links.ts
//
// Manual links-check entry (links line L2, plan §4.6):
//
//   pnpm jobs:check-links [--dry-run] [--limit N]
//
// `--dry-run` performs the full network checks but writes nothing (one pass
// of up to `--limit`, default 50); the real run loops within the budget.
// Shares the core with the `links.check` builtin and takes the same session
// advisory lock as the drain job (`web_lair.job.links.check`), so a manual
// run can never overlap a scheduled one.
//
// Exit codes: 0 = run finished (per-site failures live in the ring, not the
// exit code); 1 = the run broke; 2 = configuration error; 3 = lock busy.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getOption } from '../../src/lib/server/config/options-registry.ts';
import {
	deriveAcceptedHosts,
	LINK_LOCK_KEY,
	publicOrigin,
	runLinkCheck
} from '../../src/lib/server/links/job.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('[links] DATABASE_URL is required (run via `pnpm jobs:check-links`).');
	process.exit(2);
}

const dryRun = process.argv.includes('--dry-run');
const limitAt = process.argv.indexOf('--limit');
const limitPerPass = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : undefined;
if (limitAt >= 0 && (!Number.isInteger(limitPerPass) || (limitPerPass as number) < 1)) {
	console.error('[links] --limit expects a positive integer');
	process.exit(2);
}

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);
const lockConnection = await client.reserve();
const [lock] = await lockConnection`select pg_try_advisory_lock(hashtext(${LINK_LOCK_KEY})) as ok`;
if (lock?.ok !== true) {
	console.error('[links] a check run is already in progress (lock busy); try again later.');
	await client.end({ timeout: 5 });
	process.exit(3);
}

try {
	const checks = await getOption('friends.checks', db);
	const policy = await getOption('friends.policy', db);
	const origin = publicOrigin();
	const summary = await runLinkCheck({
		db,
		config: checks,
		acceptedHosts: deriveAcceptedHosts(origin, policy.acceptedBacklinkHosts),
		origin,
		logger: {
			info: (line) => console.log(line),
			warn: (line) => console.warn(line),
			error: (line) => console.error(line)
		},
		dryRun,
		limitPerPass
	});
	if (summary.disabled) {
		console.log('[links] checks disabled (friends.checks.enabled=false)');
	} else {
		console.log(
			`[links] ${dryRun ? 'dry-run ' : ''}done: due=${summary.due} checked=${summary.checked} ok=${summary.ok} failed=${summary.failed} skipped=${summary.skipped} inconclusive=${summary.inconclusive} writes=${summary.writes} errors=${summary.errors} budgetExhausted=${summary.budgetExhausted}${summary.backlinkSkippedReason ? ` backlinkSkipped=${summary.backlinkSkippedReason}` : ''}`
		);
		if (dryRun) console.log('[links] dry-run: no database writes were made (single pass)');
	}
} catch (err) {
	console.error(`[links] run failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
} finally {
	await lockConnection`select pg_advisory_unlock(hashtext(${LINK_LOCK_KEY}))`;
	await client.end({ timeout: 5 });
}

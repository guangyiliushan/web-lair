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
import { sanitizeErrorText } from '../../src/lib/server/jobs/error-text.ts';
import { getOption } from '../../src/lib/server/config/options-registry.ts';
import { parseLinksCliArgs } from '../../src/lib/server/links/cli-args.ts';
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

const parsedArgs = parseLinksCliArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
	// Unknown flags / bad values: a typo must not silently run in WRITE
	// mode (the --dry-run gate is load-bearing; review batch 2026-10-06).
	console.error(`[links] ${parsedArgs.error}`);
	process.exit(2);
}
const { dryRun, limitPerPass } = parsedArgs.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);
const lockConnection = await client.reserve().catch((err: unknown) => {
	console.error(
		`[links] failed to acquire the lock connection: ${sanitizeErrorText(err instanceof Error ? err.message : err)}`
	);
	process.exit(1);
});
const [lock] = await lockConnection`select pg_try_advisory_lock(hashtext(${LINK_LOCK_KEY})) as ok`;
if (lock?.ok !== true) {
	console.error('[links] a check run is already in progress (lock busy); try again later.');
	await lockConnection.release();
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
			`[links] ${dryRun ? 'dry-run ' : ''}done: due=${summary.due} checked=${summary.checked} ok=${summary.ok} failed=${summary.failed} skipped=${summary.skipped} inconclusive=${summary.inconclusive} writes=${summary.writes} errors=${summary.errors} casSkipped=${summary.casSkipped} transitions=${summary.transitions} budgetExhausted=${summary.budgetExhausted}${summary.backlinkSkippedReason ? ` backlinkSkipped=${summary.backlinkSkippedReason}` : ''}`
		);
		if (dryRun) console.log('[links] dry-run: no database writes were made (single pass)');
	}
} catch (err) {
	// drizzle wraps PG errors: surface the cause message too (e.g. 42804),
	// sanitized like the drain (bound params + URL credentials stripped;
	// the SQL text is kept - table/column names only).
	const cause =
		err !== null && typeof err === 'object' && 'cause' in err
			? (err as { cause?: unknown }).cause
			: undefined;
	const detail = cause instanceof Error ? ` (${cause.message})` : '';
	console.error(
		`[links] run failed: ${sanitizeErrorText(`${err instanceof Error ? err.message : String(err)}${detail}`)}`
	);
	process.exitCode = 1;
} finally {
	await lockConnection`select pg_advisory_unlock(hashtext(${LINK_LOCK_KEY}))`;
	await lockConnection.release();
	await client.end({ timeout: 5 });
}

// scripts/jobs/sync-projects.ts
//
// Manual projects-sync entry (projects line C batch, plan §3/§18.3):
//
//   pnpm jobs:sync-projects [--dry-run] [--provider <p>] [--account <a>] [--refresh-ids <id,id>]
//
// Direct run, sharing the same session advisory lock as the drain job
// (`web_lair.job.projects.sync`) - a manual run can never overlap a queued
// one. `--dry-run` performs the full run but writes nothing. `--provider` /
// `--account` narrow the configured targets; a named pair that is not
// configured yet runs as an ad-hoc target (operator convenience for a first
// sync). `--refresh-ids` re-GETs selected rows and skips target listing.
//
// Exit codes: 0 = run finished (per-repo failures live in the summary);
// 1 = the run broke; 2 = configuration / argument error; 3 = lock busy.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getOption } from '../../src/lib/server/config/options-registry.ts';
import { sanitizeErrorText } from '../../src/lib/server/jobs/error-text.ts';
import { parseProjectsCliArgs } from '../../src/lib/server/projects/cli-args.ts';
import { PROJECT_SYNC_LOCK_KEY, runSync } from '../../src/lib/server/projects/sync.ts';
import type { SyncTarget } from '../../src/lib/server/projects/types.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('[projects] DATABASE_URL is required (run via `pnpm jobs:sync-projects`).');
	process.exit(2);
}

const parsed = parseProjectsCliArgs(process.argv.slice(2));
if (!parsed.ok) {
	// Unknown flags / bad values: a typo must not silently run in WRITE mode.
	console.error(`[projects] ${parsed.error}`);
	process.exit(2);
}
const { dryRun, provider, account, refreshIds } = parsed.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);
const lockConnection = await client.reserve().catch((err: unknown) => {
	console.error(
		`[projects] failed to acquire the lock connection: ${sanitizeErrorText(err instanceof Error ? err.message : String(err))}`
	);
	process.exit(1);
});
const [lock] =
	await lockConnection`select pg_try_advisory_lock(hashtext(${PROJECT_SYNC_LOCK_KEY})) as ok`;
if (lock?.ok !== true) {
	console.error('[projects] a sync run is already in progress (lock busy); try again later.');
	await lockConnection.release();
	await client.end({ timeout: 5 });
	process.exit(3);
}

try {
	let targets: SyncTarget[] = [];
	if (refreshIds && refreshIds.length > 0 && (provider || account)) {
		// Do not silently drop the filters: refresh mode ignores them by
		// design (it addresses rows, not targets).
		console.warn(
			'[projects] --refresh-ids ignores --provider/--account (rows are addressed by id).'
		);
	}
	if (!refreshIds || refreshIds.length === 0) {
		targets = await getOption('projects.sync_targets', db);
		if (provider) targets = targets.filter((target) => target.provider === provider);
		if (account) targets = targets.filter((target) => target.account === account);
		if (provider && account && targets.length === 0) {
			targets = [{ provider, account }];
		}
		if (targets.length === 0) {
			console.log(
				'[projects] no sync targets configured - add accounts under /admin/projects or via the projects.sync_targets option.'
			);
		}
	}
	const summary = await runSync({
		db,
		targets,
		refreshIds,
		dryRun,
		logger: {
			info: (line) => console.log(line),
			warn: (line) => console.warn(line),
			error: (line) => console.error(line)
		}
	});
	for (const failure of summary.failures) {
		console.log(
			`[projects] failure: ${failure.provider}/${failure.account}${failure.repo ? `/${failure.repo}` : ''} -> ${failure.kind}`
		);
	}
	console.log(
		`[projects] ${dryRun ? 'dry-run ' : ''}done: added=${summary.added} updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`
	);
	if (summary.failures.some((failure) => failure.kind === 'rate_limited')) {
		console.log('[projects] rate limited: configure PROJECTS_* tokens in .env to raise the quota.');
	}
	if (dryRun) console.log('[projects] dry-run: no database writes were made.');
} catch (err) {
	const cause =
		err !== null && typeof err === 'object' && 'cause' in err
			? (err as { cause?: unknown }).cause
			: undefined;
	const detail = cause instanceof Error ? ` (${cause.message})` : '';
	console.error(
		`[projects] run failed: ${sanitizeErrorText(`${err instanceof Error ? err.message : String(err)}${detail}`)}`
	);
	process.exitCode = 1;
} finally {
	await lockConnection`select pg_advisory_unlock(hashtext(${PROJECT_SYNC_LOCK_KEY}))`;
	await lockConnection.release();
	await client.end({ timeout: 5 });
}

// scripts/jobs/links-prune.ts
//
// Manual outdated-link prune (M3 / links plan §5.1):
//
//   pnpm jobs:links-prune [--dry-run] [--grace-days N]
//
// Deletes `outdated` rows whose `lost_since` is older than
// `friends.checks.graceDays` (or the `--grace-days` override). `--dry-run`
// only counts; unknown flags exit 2 so a typo can never delete rows.
//
// Exit codes: 0 = run finished, 1 = the run broke, 2 = configuration error.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sanitizeErrorText } from '../../src/lib/server/jobs/error-text.ts';
import { getOption } from '../../src/lib/server/config/options-registry.ts';
import { parsePruneArgs, pruneOutdated } from '../../src/lib/server/links/prune.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('[links-prune] DATABASE_URL is required (run via `pnpm jobs:links-prune`).');
	process.exit(2);
}

const parsedArgs = parsePruneArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
	console.error(`[links-prune] ${parsedArgs.error}`);
	process.exit(2);
}
const { dryRun, graceDays: override } = parsedArgs.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);

try {
	const checks = override === null ? await getOption('friends.checks', db) : null;
	const graceDays = override ?? checks!.graceDays;
	const result = await pruneOutdated({ graceDays, dryRun }, { db });
	console.log(
		dryRun
			? `[links-prune] dry-run: would delete=${result.matched} (graceDays=${result.graceDays})`
			: `[links-prune] done: deleted=${result.deleted} (graceDays=${result.graceDays})`
	);
} catch (err) {
	const cause =
		err !== null && typeof err === 'object' && 'cause' in err
			? (err as { cause?: unknown }).cause
			: undefined;
	const detail = cause instanceof Error ? ` (${cause.message})` : '';
	console.error(
		`[links-prune] run failed: ${sanitizeErrorText(`${err instanceof Error ? err.message : String(err)}${detail}`)}`
	);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}

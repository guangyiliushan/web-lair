// scripts/jobs/revisions-prune.ts
//
// Manual publish-revision prune (M5):
//
//   pnpm jobs:revisions-prune [--dry-run] [--keep N]
//
// Deletes `post_revisions` rows beyond the newest N per post (default 20,
// ledger §9.3). `--dry-run` only counts. Unknown flags exit 2 so a typo can
// never delete rows.
//
// Exit codes: 0 = run finished, 1 = the run broke, 2 = configuration error.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
	REVISION_KEEP_PER_POST,
	pruneRevisions
} from '../../src/lib/server/maintenance/revisions.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error(
		'[revisions-prune] DATABASE_URL is required (run via `pnpm jobs:revisions-prune`).'
	);
	process.exit(2);
}

interface Args {
	dryRun: boolean;
	keep: number;
}

function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
	let dryRun = false;
	let keep = REVISION_KEEP_PER_POST;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--keep') {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 1) {
				return { ok: false, error: `--keep needs a positive integer (got ${raw ?? 'nothing'})` };
			}
			keep = value;
		} else {
			return { ok: false, error: `unknown argument: ${arg}` };
		}
	}
	return { ok: true, args: { dryRun, keep } };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
	console.error(`[revisions-prune] ${parsed.error}`);
	process.exit(2);
}
const { dryRun, keep } = parsed.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);

try {
	const result = await pruneRevisions({ keep, dryRun }, { db: db as never });
	if (dryRun) {
		console.log(`→ dry-run: keep=${result.keep} candidates=${result.matched} (nothing deleted)`);
	} else {
		console.log(`→ keep=${result.keep} deleted=${result.deleted}`);
	}
	process.exitCode = 0;
} catch (error) {
	console.error(`[revisions-prune] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}

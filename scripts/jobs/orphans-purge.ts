// scripts/jobs/orphans-purge.ts
//
// Manual orphan sweep (M5):
//
//   pnpm jobs:orphans-purge [--dry-run] [--draft-grace-days N]
//
// Clears `file_references` whose polymorphic target no longer exists (through
// `syncFileReferences`, so `files.status` stays correct) and deletes orphan
// drafts older than the grace window (default 30 days). `moments` are excluded.
// `--dry-run` only counts. Unknown flags exit 2 so a typo can never delete.
//
// Exit codes: 0 = run finished, 1 = the run broke, 2 = configuration error.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DRAFT_ORPHAN_GRACE_DAYS, purgeOrphans } from '../../src/lib/server/maintenance/orphans.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('[orphans-purge] DATABASE_URL is required (run via `pnpm jobs:orphans-purge`).');
	process.exit(2);
}

interface Args {
	dryRun: boolean;
	draftGraceDays: number;
}

function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
	let dryRun = false;
	let draftGraceDays = DRAFT_ORPHAN_GRACE_DAYS;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--draft-grace-days') {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 0) {
				return {
					ok: false,
					error: `--draft-grace-days needs a non-negative integer (got ${raw ?? 'nothing'})`
				};
			}
			draftGraceDays = value;
		} else {
			return { ok: false, error: `unknown argument: ${arg}` };
		}
	}
	return { ok: true, args: { dryRun, draftGraceDays } };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
	console.error(`[orphans-purge] ${parsed.error}`);
	process.exit(2);
}
const { dryRun, draftGraceDays } = parsed.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);

try {
	const result = await purgeOrphans({ dryRun, draftGraceDays }, { db: db as never });
	if (dryRun) {
		console.log(
			`→ dry-run: refGroups=${result.refGroups} refRows=${result.refRows} drafts=${result.drafts} (grace ${result.draftGraceDays}d, nothing deleted)`
		);
	} else {
		console.log(
			`→ refGroups=${result.refGroups} refRows=${result.refRows} drafts=${result.drafts} (grace ${result.draftGraceDays}d)`
		);
	}
	process.exitCode = 0;
} catch (error) {
	console.error(`[orphans-purge] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}

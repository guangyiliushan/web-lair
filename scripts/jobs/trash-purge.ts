// scripts/jobs/trash-purge.ts
//
// Manual trash purge:
//
//   pnpm jobs:trash-purge [--dry-run] [--grace-days N]
//
// Deletes trashed post families whose source row has been in the trash longer
// than the grace window (default 30 days), and only when every family member is
// trashed - a mixed family could hide a still-published translation. `--dry-run`
// only counts. Unknown flags exit 2 so a typo can never delete rows.
//
// No schedule is installed by default (single-operator ruling).
//
// Exit codes: 0 = run finished, 1 = the run broke, 2 = configuration error.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { purgeTrashedPosts, TRASH_GRACE_DAYS } from '../../src/lib/server/maintenance/trash.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('[trash-purge] DATABASE_URL is required (run via `pnpm jobs:trash-purge`).');
	process.exit(2);
}

interface Args {
	dryRun: boolean;
	graceDays: number;
}

function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
	let dryRun = false;
	let graceDays = TRASH_GRACE_DAYS;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--grace-days') {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 0) {
				return {
					ok: false,
					error: `--grace-days needs a non-negative integer (got ${raw ?? 'nothing'})`
				};
			}
			graceDays = value;
		} else {
			return { ok: false, error: `unknown argument: ${arg}` };
		}
	}
	return { ok: true, args: { dryRun, graceDays } };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
	console.error(`[trash-purge] ${parsed.error}`);
	process.exit(2);
}
const { dryRun, graceDays } = parsed.args;

const client = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client);

try {
	const result = await purgeTrashedPosts({ dryRun, graceDays }, { db: db as never });
	if (dryRun) {
		console.log(
			`→ dry-run: candidates=${result.candidates} families=${result.deletedFamilies} posts=${result.deletedPosts} skippedMixed=${result.skippedMixedFamily} (grace ${result.graceDays}d, nothing deleted)`
		);
	} else {
		console.log(
			`→ families=${result.deletedFamilies} posts=${result.deletedPosts} skippedMixed=${result.skippedMixedFamily} (grace ${result.graceDays}d)`
		);
	}
	process.exitCode = 0;
} catch (error) {
	console.error(`[trash-purge] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}

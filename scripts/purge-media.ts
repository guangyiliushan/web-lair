import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/lib/server/db/schema';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';
import { purgeMedia } from '../src/lib/server/services/files';

/**
 * Media purge (storage line §4.6): DRY-RUN by default — pass `--yes` to
 * actually delete. TTLs come from the `media.purge` option (pending 7d /
 * detached 30d). Candidates are re-checked for references at delete time.
 *
 * Dependencies are constructed here (see media-audit.ts for why the service
 * defaults cannot be used from plain tsx).
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}
const execute = process.argv.includes('--yes');

const sql = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sql, { schema });
const storage = new RustFsStorage(storageConfigFromEnv(process.env));

const outcome = await purgeMedia({ dryRun: !execute }, { db, storage });

console.log(`purge ${execute ? 'EXECUTE' : 'dry-run'} — candidates: ${outcome.candidates.length}`);
for (const candidate of outcome.candidates) {
	console.log(
		`    - ${candidate.objectKey}  (${candidate.fileName}, ${candidate.status}, ${candidate.ageDays}d)`
	);
}
if (outcome.scanTruncated) {
	console.log(
		'WARNING: the content mention scan hit its row cap — the in-use guard is partial; execution fails closed (no deletions).'
	);
}
if (outcome.skipped.length > 0) {
	const reasons: Array<[string, string]> = [
		['mentioned', 'still mentioned by stored content'],
		['reused', 'used (dedupe anchor refreshed) since the snapshot'],
		['referenced', 'gained references since the snapshot'],
		['gone', 'vanished before the delete (concurrent purge)'],
		['scan-truncated', 'fail-closed: mention scan hit its row cap']
	];
	console.log(`skipped: ${outcome.skipped.length}`);
	for (const [reason, label] of reasons) {
		const keys = outcome.skipped
			.filter((entry) => entry.reason === reason)
			.map((entry) => entry.objectKey);
		if (keys.length === 0) continue;
		console.log(`    ~ [${reason}] ${label}: ${keys.length}`);
		for (const key of keys) console.log(`        ${key}`);
	}
}
if (execute) {
	console.log(`deleted: ${outcome.deleted.length}`);
	for (const failure of outcome.failed) {
		console.log(`FAILED ${failure.objectKey}: ${failure.reason}`);
	}
} else {
	console.log('no changes (dry-run). Re-run with --yes to delete the candidates above.');
}

await sql.end();

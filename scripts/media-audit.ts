import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/lib/server/db/schema';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';
import { runMediaAudit } from '../src/lib/server/services/files';

/**
 * Read-only media audit (storage line §4.6 three checks, T6): orphans /
 * broken links / missing objects. Idempotent — touches nothing. `--strict`
 * exits non-zero when findings exist (for later cron/monitoring wiring).
 *
 * Dependencies are constructed here instead of relying on the service
 * defaults: the app `db` / `getStorage()` modules import `$env/dynamic/private`,
 * which exists only inside the SvelteKit runtime — the same constraint
 * verify-media documents.
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}
const strict = process.argv.includes('--strict');

const sql = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sql, { schema });
const storage = new RustFsStorage(storageConfigFromEnv(process.env));

const report = await runMediaAudit({ db, storage });

console.log(`media audit @ ${report.generatedAt}`);
if (report.truncated) {
	console.log(
		'  NOTE: a scan hit its row limit — results may be incomplete (registered: paginate as content grows)'
	);
}
console.log(
	`  scanned: posts=${report.scannedSources.posts} drafts=${report.scannedSources.drafts} notes=${report.scannedSources.notes}`
);
console.log(`  orphan  (no refs, not a photo, past TTL): ${report.orphans.length}`);
for (const row of report.orphans) {
	console.log(`      - ${row.objectKey}  (${row.fileName}, ${row.status}, ${row.ageDays}d)`);
}
console.log(
	`  broken  (content mentions /i/<key> without a files row): ${report.brokenLinks.length}`
);
for (const link of report.brokenLinks) {
	console.log(`      - ${link.key}  <- ${link.refType}:${link.refId}`);
}
console.log(`  missing (row present, object absent): ${report.missingObjects.length}`);
for (const row of report.missingObjects) {
	console.log(`      - ${row.objectKey}  (${row.fileName})`);
}

const findings = report.orphans.length + report.brokenLinks.length + report.missingObjects.length;
if (findings === 0) {
	console.log('clean.');
} else {
	console.log(`findings: ${findings}${strict ? '' : ' (run with --strict to exit non-zero)'}`);
}

await sql.end();
process.exit(strict && findings > 0 ? 1 : 0);

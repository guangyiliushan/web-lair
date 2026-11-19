import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { files } from '../src/lib/server/db/content';
import { variantKeyFor } from '../src/lib/media/keys';
import { activeStorage } from './lib/active-storage';
import { processImage } from '../src/lib/server/media/variants';

/**
 * One-off backfill for the gallery's 720px `@grid` tier. Existing rows keep
 * working through the `/i` route's short-cache thumb fallback, but 2× screens
 * want the grid box. Idempotent: files that already carry `@grid` are skipped.
 *
 * Usage:
 *   pnpm ops db backfill-grid --dry-run
 *   pnpm ops db backfill-grid --limit=50
 *   pnpm ops db backfill-grid
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length))) : null;

const sql = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sql, { schema });
// Variants are written to the ACTIVE provider.
const storage = await activeStorage(db);

const rows = await db
	.select({ objectKey: files.objectKey, fileName: files.fileName, mimeType: files.mimeType })
	.from(files)
	.where(
		and(
			eq(files.status, 'attached'),
			inArray(files.mimeType, [
				'image/jpeg',
				'image/png',
				'image/webp',
				'image/avif',
				'image/heic',
				'image/heif',
				'image/tiff'
			])
		)
	)
	.orderBy(files.createdAt)
	.limit(limit ?? 10_000);

let created = 0;
let skipped = 0;
let missing = 0;
let failed = 0;

for (const row of rows) {
	const gridKey = variantKeyFor(row.objectKey, 'grid');
	const existing = await storage.head(gridKey);
	if (existing) {
		skipped += 1;
		continue;
	}
	if (dryRun) {
		console.log(`would create ${gridKey}  (${row.fileName})`);
		created += 1;
		continue;
	}
	const original = await storage.get(row.objectKey);
	if (!original) {
		console.warn(`missing original ${row.objectKey}  (${row.fileName})`);
		missing += 1;
		continue;
	}
	try {
		const bytes = new Uint8Array(await new Response(original.body).arrayBuffer());
		const processed = await processImage(bytes);
		await storage.put(gridKey, processed.variants.grid, { contentType: 'image/webp' });
		console.log(`created ${gridKey}  (${row.fileName})`);
		created += 1;
	} catch (error) {
		failed += 1;
		console.warn(`failed ${gridKey}  (${row.fileName})`, error);
	}
}

console.log(
	`grid backfill ${dryRun ? '(dry run) ' : ''}done: created=${created} skipped=${skipped} missing=${missing} failed=${failed}`
);
await sql.end();
process.exit(failed > 0 ? 1 : 0);

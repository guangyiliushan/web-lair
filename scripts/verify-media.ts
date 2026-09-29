import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '../src/lib/server/db/schema';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';
import {
	deleteFile,
	listPurgeCandidates,
	purgeMedia,
	runMediaAudit,
	uploadFile
} from '../src/lib/server/services/files';

/**
 * One-time media verification (storage line §4.6 / T5 / T6) against the dev
 * stack — real Postgres + real RustFS. Constructs the three audit cases
 * (orphan / broken link / missing object), exercises the upload pipeline,
 * dedupe, reference guards and the dry-run contract, then removes every probe
 * again. Exit code 0 = all checks passed; 1 = failures (details above).
 *
 * Run: pnpm db:verify-media   (requires `docker compose up` for db + rustfs)
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sql, { schema });
const storage = new RustFsStorage(storageConfigFromEnv(process.env));
const deps = { db, storage };

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
	checks += 1;
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!condition) failures += 1;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const stamp = Date.now().toString(36);
const orphanHash = sha256(`verify-media-orphan-${stamp}`);
const missingHash = sha256(`verify-media-missing-${stamp}`);
const brokenHash = sha256(`verify-media-broken-${stamp}`);
const orphanKey = `${orphanHash.slice(0, 2)}/${orphanHash}.bin`;
const missingKey = `${missingHash.slice(0, 2)}/${missingHash}.jpg`;
const brokenKey = `${brokenHash.slice(0, 2)}/${brokenHash}.jpg`;
const draftTitle = `verify-media-broken-${stamp}`;

let uploadedId: string | null = null;
let refId: string | null = null;
let baseline: number | null = null;

async function cleanup(): Promise<void> {
	// Best-effort: remove every probe row/object even when checks failed.
	await db.delete(schema.files).where(inArray(schema.files.objectKey, [orphanKey, missingKey]));
	await db.delete(schema.drafts).where(eq(schema.drafts.title, draftTitle));
	await storage.delete(orphanKey);
	if (refId) {
		await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, refId));
	}
	if (uploadedId) {
		// deleteFile honours the reference guard; probes must be unreferenced by now.
		await deleteFile(uploadedId, deps);
	}
}

async function main(): Promise<void> {
	const before = await db.$count(schema.files);
	baseline = before;

	// -- T5: purge dry-run is read-only --------------------------------------
	const dryRun = await purgeMedia({ dryRun: true }, deps);
	check(
		'purge dry-run deletes nothing',
		dryRun.dryRun === true && dryRun.deleted.length === 0,
		`candidates=${dryRun.candidates.length}`
	);
	check('purge dry-run leaves the registry untouched', (await db.$count(schema.files)) === before);

	// -- upload pipeline roundtrip (live storage) ----------------------------
	const png = await sharp({
		create: { width: 6, height: 4, channels: 3, background: { r: 51, g: 85, b: 119 } }
	})
		.png()
		.toBuffer();
	const uploaded = await uploadFile(
		{ fileName: `verify-media-${stamp}.png`, bytes: png, uploadedBy: null },
		deps
	);
	uploadedId = uploaded.id;
	check('upload returns a pending row', uploaded.status === 'pending' && !uploaded.deduplicated);
	check('original object exists', (await storage.head(uploaded.objectKey)) !== null);
	check('thumb variant exists', (await storage.head(`${uploaded.objectKey}@thumb`)) !== null);
	check('full variant exists', (await storage.head(`${uploaded.objectKey}@full`)) !== null);

	const duplicate = await uploadFile(
		{ fileName: `verify-media-${stamp}-copy.png`, bytes: png, uploadedBy: null },
		deps
	);
	check(
		'duplicate upload deduplicates to the same row',
		duplicate.id === uploaded.id && duplicate.deduplicated === true
	);

	// -- reference guard ------------------------------------------------------
	refId = randomUUID();
	await db.insert(schema.fileReferences).values({ fileId: uploaded.id, refType: 'post', refId });
	const blocked = await deleteFile(uploaded.id, deps);
	check(
		'referenced file delete is blocked',
		blocked.kind === 'referenced' && blocked.refCount === 1,
		`kind=${blocked.kind}`
	);
	const withRef = await listPurgeCandidates(deps);
	check(
		'referenced file is never a purge candidate',
		!withRef.some((candidate) => candidate.id === uploaded.id)
	);
	await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, refId));
	refId = null;
	const deleted = await deleteFile(uploaded.id, deps);
	uploadedId = null;
	check('unreferenced file deletes cleanly', deleted.kind === 'ok');
	check('objects removed with the row', (await storage.head(uploaded.objectKey)) === null);

	// -- constructed audit cases ---------------------------------------------
	await storage.put(orphanKey, Buffer.from('orphan-probe'), {
		contentType: 'application/octet-stream'
	});
	await db.insert(schema.files).values({
		objectKey: orphanKey,
		contentHash: orphanHash,
		fileName: `verify-orphan-${stamp}.bin`,
		mimeType: 'application/octet-stream',
		byteSize: 12,
		status: 'pending',
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
	});
	await db.insert(schema.drafts).values({
		refType: 'post',
		title: draftTitle,
		content: `see /i/${brokenKey} for details`
	});
	await db.insert(schema.files).values({
		objectKey: missingKey,
		contentHash: missingHash,
		fileName: `verify-missing-${stamp}.jpg`,
		mimeType: 'image/jpeg',
		byteSize: 1,
		status: 'attached'
	});

	const report = await runMediaAudit(deps);
	check(
		'① orphan detected (no refs, not a photo, past TTL)',
		report.orphans.some((candidate) => candidate.objectKey === orphanKey)
	);
	check(
		'② broken link detected (content mentions a key with no row)',
		report.brokenLinks.some((link) => link.key === brokenKey && link.refType === 'draft')
	);
	check(
		'③ missing object detected (row without an object)',
		report.missingObjects.some((row) => row.objectKey === missingKey)
	);
	check(
		'healthy rows are not flagged as missing',
		!report.missingObjects.some((row) => row.objectKey === orphanKey)
	);

	const dryRun2 = await purgeMedia({ dryRun: true }, deps);
	check(
		'purge candidates include the orphan',
		dryRun2.candidates.some((candidate) => candidate.objectKey === orphanKey)
	);
	check(
		'purge excludes attached rows',
		!dryRun2.candidates.some((candidate) => candidate.objectKey === missingKey)
	);
	check('purge dry-run again deletes nothing', (await db.$count(schema.files)) === before + 2);
}

try {
	await main();
} catch (error) {
	failures += 1;
	console.error('FAIL unexpected error:', error);
} finally {
	await cleanup().catch((error) => {
		failures += 1;
		console.error('FAIL cleanup error:', error);
	});
	const after = await db.$count(schema.files).catch(() => -1);
	check(
		'registry back to baseline after cleanup',
		baseline === null || after === baseline,
		`before=${baseline} after=${after}`
	);
	console.log(`\nchecks=${checks} failures=${failures}`);
	await sql.end();
	process.exit(failures === 0 ? 0 : 1);
}

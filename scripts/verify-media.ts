import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '../src/lib/server/db/schema';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';
import { objectKeyFor, variantKeyFor } from '../src/lib/media/keys';
import {
	deleteFile,
	listFiles,
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
const orphanKey = objectKeyFor(orphanHash, 'bin');
const missingKey = objectKeyFor(missingHash, 'jpg');
const brokenKey = objectKeyFor(brokenHash, 'jpg');
const draftTitle = `verify-media-broken-${stamp}`;
const galleryHash = sha256(`verify-media-gallery-${stamp}`);
const galleryKey = objectKeyFor(galleryHash, 'png');
const gallerySlug = `verify-media-gallery-${stamp}`;
const guardHash = sha256(`verify-media-guard-${stamp}`);
const guardKey = objectKeyFor(guardHash, 'jpg');
const guardTitle = `verify-media-guard-${stamp}`;

let uploadedId: string | null = null;
let uploadedKey: string | null = null;
let refId: string | null = null;

/** Scoped probe-row counter: immune to concurrent activity on the live db. */
async function probeRowCount(keys: string[]): Promise<number> {
	const rows = await db
		.select({ objectKey: schema.files.objectKey })
		.from(schema.files)
		.where(inArray(schema.files.objectKey, keys));
	return rows.length;
}

async function cleanup(): Promise<void> {
	// Best-effort: remove every probe row/object even when checks failed.
	// photos references files with NO ACTION — drop the gallery link first.
	await db.delete(schema.photos).where(eq(schema.photos.slug, gallerySlug));
	await db
		.delete(schema.files)
		.where(inArray(schema.files.objectKey, [orphanKey, missingKey, galleryKey, guardKey]));
	await db.delete(schema.drafts).where(inArray(schema.drafts.title, [draftTitle, guardTitle]));
	await storage.delete(orphanKey);
	await storage.delete(galleryKey);
	await storage.delete(guardKey);
	if (refId) {
		await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, refId));
	}
	if (uploadedId) {
		// deleteFile honours the reference guard; probes must be unreferenced by now.
		await deleteFile(uploadedId, deps);
	}
}

async function main(): Promise<void> {
	// -- T5: purge dry-run is read-only --------------------------------------
	const dryRun = await purgeMedia({ dryRun: true }, deps);
	check(
		'purge dry-run deletes nothing',
		dryRun.dryRun === true && dryRun.deleted.length === 0,
		`candidates=${dryRun.candidates.length}`
	);

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
	uploadedKey = uploaded.objectKey;
	check('upload returns a pending row', uploaded.status === 'pending' && !uploaded.deduplicated);
	check('original object exists', (await storage.head(uploaded.objectKey)) !== null);
	check(
		'thumb variant exists',
		(await storage.head(variantKeyFor(uploaded.objectKey, 'thumb'))) !== null
	);
	check(
		'full variant exists',
		(await storage.head(variantKeyFor(uploaded.objectKey, 'full'))) !== null
	);

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
	check(
		'purge dry-run again deletes nothing (probe rows still present)',
		(await probeRowCount([orphanKey, missingKey])) === 2
	);

	// -- §6.1 "orphan" filter (admin list view) ------------------------------
	const orphanView = await listFiles({ orphan: true }, deps);
	check(
		'listFiles({ orphan }) surfaces the constructed orphan',
		orphanView.some((row) => row.objectKey === orphanKey)
	);
	check(
		'listFiles({ orphan }) excludes healthy / attached rows',
		!orphanView.some((row) => row.objectKey === missingKey)
	);

	// -- §4.6/§6.1 photos exemption (query-layer guard) ----------------------
	await db.insert(schema.files).values({
		objectKey: galleryKey,
		contentHash: galleryHash,
		fileName: `verify-gallery-${stamp}.png`,
		mimeType: 'image/png',
		byteSize: 1,
		status: 'pending',
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
	});
	const [galleryFile] = await db
		.select({ id: schema.files.id })
		.from(schema.files)
		.where(eq(schema.files.objectKey, galleryKey));
	await db.insert(schema.photos).values({ fileId: galleryFile.id, slug: gallerySlug });
	const guarded = await purgeMedia({ dryRun: true }, deps);
	check(
		'photos-linked file is never a purge candidate',
		!guarded.candidates.some((candidate) => candidate.objectKey === galleryKey)
	);
	const orphanView2 = await listFiles({ orphan: true }, deps);
	check(
		'photos-linked file is hidden from the orphan view',
		!orphanView2.some((row) => row.objectKey === galleryKey)
	);
	check('purge dry-run never touches objects', (await storage.head(orphanKey)) !== null);

	// -- purge mention guard (§11 hold: refs backfill lands with ST-3) -------
	await storage.put(guardKey, Buffer.from('guard-probe'), { contentType: 'image/jpeg' });
	await db.insert(schema.files).values({
		objectKey: guardKey,
		contentHash: guardHash,
		fileName: `verify-guard-${stamp}.jpg`,
		mimeType: 'image/jpeg',
		byteSize: 11,
		status: 'pending',
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
	});
	await db.insert(schema.drafts).values({
		refType: 'post',
		title: guardTitle,
		content: `inline /i/${guardKey} reference`
	});
	const executed = await purgeMedia({ dryRun: false }, deps);
	check(
		'purge execution skips keys still mentioned by content',
		executed.skipped.includes(guardKey)
	);
	check('mentioned file row survives execution', (await probeRowCount([guardKey])) === 1);
	check(
		'unmentioned orphan IS purged (execute)',
		executed.deleted.includes(orphanKey) && (await probeRowCount([orphanKey])) === 0
	);
	check(
		'purged row takes its objects with it',
		(await storage.head(orphanKey)) === null &&
			(await storage.head(variantKeyFor(orphanKey, 'thumb'))) === null
	);
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
	const probes = [
		orphanKey,
		missingKey,
		galleryKey,
		guardKey,
		...(uploadedKey ? [uploadedKey] : [])
	];
	const remaining = await probeRowCount(probes).catch(() => -1);
	check('probe rows are gone after cleanup', remaining === 0, `remaining=${remaining}`);
	const leftoverObjects = (
		await Promise.all([orphanKey, galleryKey, guardKey].map((key) => storage.head(key)))
	).filter((head) => head !== null).length;
	check('probe objects are gone after cleanup', leftoverObjects === 0, `left=${leftoverObjects}`);
	console.log(`\nchecks=${checks} failures=${failures}`);
	await sql.end();
	process.exit(failures === 0 ? 0 : 1);
}

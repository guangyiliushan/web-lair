import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '../src/lib/server/db/schema';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { StorageError } from '../src/lib/server/storage/port';
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
import {
	createPhotoFromFile,
	listPhotoNeighbors,
	listPublicPhotos,
	removePhoto,
	updatePhoto
} from '../src/lib/server/services/photos';
import { extractMakerNotes } from '../src/lib/server/media/exif-makernotes';

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
/** Narrowed copy: TS does not carry the module-level guard into closures. */
const DB_URL: string = DATABASE_URL;

let failures = 0;
let checks = 0;
let skipped = 0;

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
const raceHash = sha256(`verify-media-race-${stamp}`);
const raceKey = objectKeyFor(raceHash, 'jpg');

let uploadedId: string | null = null;
let uploadedKey: string | null = null;
let refId: string | null = null;
let raceRefId: string | null = null;
let raceSql: ReturnType<typeof postgres> | null = null;
let photoProbe: { id: string; slug: string } | null = null;
let photoProbeFileId: string | null = null;
let photoProbeKey: string | null = null;
/** keyset-precision probes (review round 1): files + photo ids for cleanup. */
const msFiles: Array<{ id: string; key: string }> = [];
const msPhotoIds: string[] = [];
let photoProbeTagSlug: string | null = null;

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
	// Refs first: the FK is NO ACTION since A2 - a leftover reference would
	// otherwise block the row cleanup below.
	if (refId) {
		await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, refId));
	}
	if (raceRefId) {
		await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, raceRefId));
	}
	if (photoProbe) {
		await db
			.delete(schema.slugTrackers)
			.where(eq(schema.slugTrackers.targetId, photoProbe.id))
			.catch(() => undefined);
		await db
			.delete(schema.photos)
			.where(eq(schema.photos.id, photoProbe.id))
			.catch(() => undefined);
	}
	if (photoProbeTagSlug) {
		await db
			.delete(schema.tags)
			.where(eq(schema.tags.slug, photoProbeTagSlug))
			.catch(() => undefined);
	}
	await db
		.delete(schema.files)
		.where(
			inArray(schema.files.objectKey, [
				orphanKey,
				missingKey,
				galleryKey,
				guardKey,
				raceKey,
				...(photoProbeKey ? [photoProbeKey] : [])
			])
		);
	await db.delete(schema.drafts).where(inArray(schema.drafts.title, [draftTitle, guardTitle]));
	await storage.delete(orphanKey);
	await storage.delete(galleryKey);
	await storage.delete(guardKey);
	if (refId) {
		await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, refId));
	}
	if (uploadedId) {
		// deleteFile honours the reference guard; probes must be unreferenced by now.
		await deleteFile(uploadedId, {}, deps);
	}
	if (raceSql) {
		await raceSql.end({ timeout: 5 }).catch(() => undefined);
	}
	if (photoProbeFileId) {
		await deleteFile(photoProbeFileId, {}, deps).catch(() => undefined);
	}
	for (const photoId of msPhotoIds) {
		await db
			.delete(schema.photos)
			.where(eq(schema.photos.id, photoId))
			.catch(() => undefined);
	}
	for (const entry of msFiles) {
		await deleteFile(entry.id, { skipMentionScan: true }, deps).catch(() => undefined);
	}
}

/** Poll a live-database predicate; the T15 probe no longer sleeps blindly. */
async function pollUntil(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
	label: string
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	console.log(`  (poll timeout: ${label})`);
	return false;
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
	const blocked = await deleteFile(uploaded.id, { skipMentionScan: true }, deps);
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
	const deleted = await deleteFile(uploaded.id, { skipMentionScan: true }, deps);
	uploadedId = null;
	check('unreferenced file deletes cleanly', deleted.kind === 'ok');
	check('objects removed with the row', (await storage.head(uploaded.objectKey)) === null);

	// -- T4 discriminator (review round 1): assert the FK ACTION itself, ------
	// not just a 23503 that CASCADE would raise the same way for this
	// direction; verify-baseline Phase B holds the negative-direction teeth.
	const [fkRow] = await sql`
		select confdeltype from pg_constraint
		where conrelid = 'file_references'::regclass and contype = 'f'
	`;
	check(
		"T4: file_references FK is NO ACTION (confdeltype = 'a')",
		fkRow?.confdeltype === 'a',
		`confdeltype=${fkRow?.confdeltype}`
	);

	// -- T15 race (ST-2): deleteFile serializes with a live reference INSERT --
	const [raceRow] = await db
		.insert(schema.files)
		.values({
			objectKey: raceKey,
			contentHash: raceHash,
			fileName: `verify-race-${stamp}.jpg`,
			mimeType: 'image/jpeg',
			byteSize: 1,
			status: 'pending'
		})
		.returning({ id: schema.files.id });
	raceRefId = randomUUID();
	raceSql = postgres(DB_URL, { max: 1 });
	let releaseBlocker!: () => void;
	const blockerHold = new Promise<void>((resolve) => (releaseBlocker = resolve));
	let blockerError: unknown = null;
	const blockerTx = raceSql
		.begin(async (tx) => {
			await tx`insert into file_references (file_id, ref_type, ref_id) values (${raceRow.id}, 'post', ${raceRefId})`;
			// Session marker so the probe can WAIT for the insert to actually
			// land (review round 1: a fixed 150ms sleep could fire too early
			// under load and pass a race it never exercised).
			await tx.unsafe("set application_name = 'wm-verify-blocker'");
			await blockerHold;
		})
		.catch((error: unknown) => {
			blockerError = error;
		});
	const blockerReady = await pollUntil(
		async () => {
			const [row] =
				await sql`select count(*)::int as n from pg_stat_activity where application_name = 'wm-verify-blocker'`;
			return (row?.n ?? 0) > 0;
		},
		10_000,
		'T15 blocker holds its insert'
	);
	check('T15 blocker holds its insert (session marker visible)', blockerReady);
	const deleteAttempt = deleteFile(raceRow.id, {}, deps);
	const raceOutcome = await Promise.race([
		deleteAttempt.then(
			() => 'settled' as const,
			() => 'settled' as const
		),
		new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 400))
	]);
	check(
		'T15 deleteFile waits on an in-flight reference insert (FOR UPDATE vs FK KEY SHARE)',
		raceOutcome === 'blocked',
		`outcome=${raceOutcome}`
	);
	releaseBlocker();
	await blockerTx;
	check('T15 blocker transaction committed cleanly', blockerError === null);
	const blockedByRace = await deleteAttempt;
	check(
		'T15 re-check sees the committed reference -> blocked',
		blockedByRace.kind === 'referenced' && blockedByRace.refCount === 1,
		`kind=${blockedByRace.kind}`
	);
	// Delete-wins direction: with the reference gone the delete succeeds, and a
	// late reference INSERT then fails 23503 (the row is already gone).
	await db.delete(schema.fileReferences).where(eq(schema.fileReferences.refId, raceRefId));
	const raceDeleted = await deleteFile(raceRow.id, {}, deps);
	check(
		'T15 unreferenced delete succeeds after the reference is removed',
		raceDeleted.kind === 'ok'
	);
	let lateInsertFailed = false;
	try {
		await db
			.insert(schema.fileReferences)
			.values({ fileId: raceRow.id, refType: 'post', refId: randomUUID() });
	} catch (error) {
		const e = error as { code?: string; cause?: { code?: string } };
		lateInsertFailed = (e?.code ?? e?.cause?.code) === '23503';
	}
	check('T15 a late reference INSERT fails 23503 (row gone)', lateInsertFailed);

	// -- photos gallery (ST-2/T15): create -> rename+tracker -> guarded -> remove
	const photoPng = await sharp({
		create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } }
	})
		.png()
		.toBuffer();
	const galleryUpload = await uploadFile(
		{ fileName: `verify-照片-${stamp}.png`, bytes: photoPng, uploadedBy: null },
		deps
	);
	photoProbeFileId = galleryUpload.id;
	photoProbeKey = galleryUpload.objectKey;
	photoProbeTagSlug = `verify-${stamp}`;
	const created = await createPhotoFromFile(galleryUpload.id, { tags: [photoProbeTagSlug] }, deps);
	check('photo created from a registry file', created.kind === 'ok', `kind=${created.kind}`);
	if (created.kind === 'ok') photoProbe = { id: created.id, slug: created.slug };
	check(
		'photo slug preserves CJK and lowercases the rest',
		created.kind === 'ok' && created.slug === `verify-照片-${stamp}`,
		`slug=${created.kind === 'ok' ? created.slug : 'n/a'}`
	);
	const blockedByGallery = await deleteFile(galleryUpload.id, {}, deps);
	check(
		'gallery-linked file delete is blocked',
		blockedByGallery.kind === 'referenced' && blockedByGallery.isInGallery === true,
		`kind=${blockedByGallery.kind}`
	);
	const renamedSlug = `verify-photo-${stamp}-renamed`;
	const renamed = photoProbe
		? await updatePhoto(photoProbe.id, { slug: renamedSlug }, deps)
		: ({ kind: 'skipped' } as const);
	check('photo slug rename succeeds', renamed.kind === 'ok', `kind=${renamed.kind}`);
	// slug-resolver statically imports the $-env db module (unavailable under
	// plain tsx); probe the tracker directly with the same ordering contract.
	const resolvedName = photoProbe
		? ((
				await db
					.select({ targetId: schema.slugTrackers.targetId })
					.from(schema.slugTrackers)
					.where(
						and(
							eq(schema.slugTrackers.type, 'photo'),
							eq(schema.slugTrackers.lang, 'en'),
							eq(schema.slugTrackers.slug, photoProbe.slug)
						)
					)
					.orderBy(desc(schema.slugTrackers.createdAt), desc(schema.slugTrackers.id))
					.limit(1)
			)[0]?.targetId ?? null)
		: null;
	check(
		'old photo slug resolves via slug_trackers',
		photoProbe !== null && resolvedName === photoProbe.id,
		`target=${resolvedName}`
	);
	const removed = photoProbe
		? await removePhoto(photoProbe.id, {}, deps)
		: ({ kind: 'skipped' } as const);
	check('photo removal keeps the file', removed.kind === 'ok', `kind=${removed.kind}`);
	const afterRemoval = await deleteFile(galleryUpload.id, {}, deps);
	check('file deletes after the photo is removed', afterRemoval.kind === 'ok');

	// -- maker-notes three-brand probes (multi-brand batch, 2026-10-10) -------
	// Official exiftool test images + the live X-T5 sample live in the
	// repo-external evidence dir (licence-clean); a missing sample SKIPS its
	// probe explicitly instead of failing the run.
	const evidenceDir =
		process.env.WL_EVIDENCE_DIR ??
		pathJoin(process.cwd(), '..', 'notes', 'backups', 'storage-st2-evidence-20261009');
	if (process.env.WL_EVIDENCE_DIR && !existsSync(evidenceDir)) {
		// An EXPLICIT evidence dir that is missing is an operator error,
		// not an optional skip (round-2 review) — fail loudly.
		console.error(`FAIL: WL_EVIDENCE_DIR is set but missing: ${evidenceDir}`);
		process.exit(1);
	}
	const mnProbes: Array<{
		file: string;
		brand: string;
		requiredKeys: string[];
		absent?: string[];
	}> = [
		{
			file: 'fuji-sample.jpg',
			brand: 'fuji',
			// The retired fuji-recipes 15-field recipe set is a strict
			// subset of the FujiFilm group dump (super-set verified
			// before the switch; recipe parity pinned below).
			requiredKeys: [
				'FilmMode',
				'GrainEffectRoughness',
				'GrainEffectSize',
				'ColorChromeEffect',
				'ColorChromeFXBlue',
				'WhiteBalance',
				'WBRed',
				'WBBlue',
				'DynamicRange',
				'HighlightTone',
				'ShadowTone',
				'Saturation',
				'Sharpness',
				'NoiseReduction',
				'Clarity'
			],
			absent: ['flashpix', 'fotostation']
		},
		{ file: 'Apple.jpg', brand: 'apple', requiredKeys: ['MakerNoteVersion', 'RunTimeValue'] },
		{ file: 'Canon.jpg', brand: 'canon', requiredKeys: ['BulbDuration', 'Quality'] }
	];
	for (const probe of mnProbes) {
		const samplePath = pathJoin(evidenceDir, probe.file);
		if (!existsSync(samplePath)) {
			skipped += 1;
			console.log(`  - makerNotes[${probe.brand}]: sample ${probe.file} missing — SKIPPED`);
			continue;
		}
		const sampleBytes = new Uint8Array(await readFile(samplePath));
		const dump = await extractMakerNotes(sampleBytes, { ext: 'jpg' });
		const brandDump = dump?.[probe.brand] as Record<string, unknown> | undefined;
		check(
			`makerNotes.${probe.brand} extracted (${probe.file})`,
			Boolean(brandDump) && Object.keys(brandDump ?? {}).length > 0,
			`dump=${dump ? Object.keys(dump).join(',') : 'null'}`
		);
		const missing = probe.requiredKeys.filter((key) => !(key in (brandDump ?? {})));
		check(
			`makerNotes.${probe.brand} carries the required keys`,
			missing.length === 0,
			`missing=${missing.join(',')}`
		);
		for (const key of probe.absent ?? []) {
			check(
				`makerNotes.${probe.brand}: non-brand group '${key}' excluded`,
				dump?.[key] === undefined
			);
		}
	}
	if (existsSync(pathJoin(evidenceDir, 'fuji-sample.jpg'))) {
		const sampleBytes = new Uint8Array(await readFile(pathJoin(evidenceDir, 'fuji-sample.jpg')));
		const dump = await extractMakerNotes(sampleBytes, { ext: 'jpg' });
		check(
			"makerNotes.fuji.FilmMode is 'Classic Chrome' (recipe parity)",
			(dump?.fuji as Record<string, unknown> | undefined)?.FilmMode === 'Classic Chrome'
		);
	}

	// -- keyset precision (review round 1): rows sharing one millisecond ------
	// (µs-differing values) must survive BOTH pagination and neighbour lookup;
	// the old ms round-trip of the sort key could silently skip them.
	const msCreate = async (suffix: string, takenAt: string, blue: number) => {
		// Distinct bytes per probe: reusing one buffer would dedupe to a
		// single files row and the second photo would read already-in-gallery.
		const bytes = await sharp({
			create: { width: 6, height: 4, channels: 3, background: { r: 51, g: 85, b: blue } }
		})
			.png()
			.toBuffer();
		const upload = await uploadFile(
			{ fileName: `verify-ms-${stamp}-${suffix}.png`, bytes, uploadedBy: null },
			deps
		);
		const photo = await createPhotoFromFile(upload.id, {}, deps);
		if (photo.kind !== 'ok') throw new Error(`ms probe photo failed: ${photo.kind}`);
		await sql`update photos set taken_at = ${takenAt}::timestamptz where id = ${photo.id}`;
		msFiles.push({ id: upload.id, key: upload.objectKey });
		msPhotoIds.push(photo.id);
		return photo.id;
	};
	const msIdA = await msCreate('a', '2099-01-01 00:00:00.123456+00', 119);
	const msIdB = await msCreate('b', '2099-01-01 00:00:00.123400+00', 120);
	const msFeed = await listPublicPhotos({}, null, 5, deps);
	check(
		'keyset ms: both same-millisecond rows are on page 1',
		msFeed.some((row) => row.id === msIdA) && msFeed.some((row) => row.id === msIdB)
	);
	const msTop = msFeed.find((row) => row.id === msIdA || row.id === msIdB);
	if (msTop) {
		const msNext = await listPublicPhotos(
			{},
			{ sortAt: (msTop.takenAt ?? msTop.createdAt).toISOString(), id: msTop.id },
			5,
			deps
		);
		check(
			'keyset ms: the cursor never skips the same-ms sibling',
			msNext.some((row) => row.id !== msTop.id && (row.id === msIdA || row.id === msIdB))
		);
		const msNeighbors = await listPhotoNeighbors(
			{ sortAt: msTop.takenAt ?? msTop.createdAt, id: msTop.id },
			deps
		);
		check(
			'keyset ms: a row is never its own neighbour',
			msNeighbors.newer?.slug !== msTop.slug && msNeighbors.older?.slug !== msTop.slug
		);
	} else {
		check('keyset ms: probe rows present', false, 'ms probe rows missing from the feed');
	}
	check('gallery upload objects removed', (await storage.head(galleryUpload.objectKey)) === null);

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
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
		// pending anchors on the LAST event (round-3): keep the probe stale.
		updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
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
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
		updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
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
		createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
		updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
	});
	await db.insert(schema.drafts).values({
		refType: 'post',
		title: guardTitle,
		content: `inline /i/${guardKey} reference`
	});
	const executed = await purgeMedia({ dryRun: false }, deps);
	check(
		'purge execution skips keys still mentioned by content',
		executed.skipped.some((entry) => entry.objectKey === guardKey)
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

	// -- §8 map service probe (T12): Range semantics through the adapter ----
	// Pins the behaviours the /maps route forwards: 200 full, 206 + exact
	// Content-Range on a ranged read, 416 (as StorageError) past the end.
	const mapProbeKey = `maps/verify-range-${stamp}.bin`;
	const mapBytes = new Uint8Array(256).map((_value, index) => index);
	await storage.put(mapProbeKey, mapBytes, { contentType: 'application/vnd.pmtiles' });
	const mapFull = await storage.get(mapProbeKey);
	check(
		'map range: full read answers 200 with the exact size',
		mapFull?.status === 200 && mapFull?.byteSize === 256,
		`status=${mapFull?.status} size=${mapFull?.byteSize}`
	);
	const mapRanged = await storage.get(mapProbeKey, { range: { start: 0, end: 9 } });
	const mapRangedBytes = mapRanged
		? new Uint8Array(await new Response(mapRanged.body).arrayBuffer())
		: null;
	check(
		'map range: ranged read answers 206 with the exact Content-Range',
		mapRanged?.status === 206 &&
			mapRanged?.contentRange === 'bytes 0-9/256' &&
			mapRangedBytes?.length === 10 &&
			mapRangedBytes[0] === 0 &&
			mapRangedBytes[9] === 9,
		`status=${mapRanged?.status} cr=${mapRanged?.contentRange} n=${mapRangedBytes?.length}`
	);
	const mapOpen = await storage.get(mapProbeKey, { range: { start: 250 } });
	check(
		'map range: open-ended range answers 206 to the end',
		mapOpen?.status === 206 && mapOpen?.contentRange === 'bytes 250-255/256',
		`status=${mapOpen?.status} cr=${mapOpen?.contentRange}`
	);
	let mapOverflow = false;
	try {
		await storage.get(mapProbeKey, { range: { start: 300, end: 400 } });
	} catch (cause) {
		mapOverflow = cause instanceof StorageError && cause.status === 416;
	}
	check('map range: unsatisfiable range surfaces as StorageError 416', mapOverflow);
	await storage.delete(mapProbeKey);
	check('map range: probe object cleaned up', (await storage.head(mapProbeKey)) === null);
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
		raceKey,
		...(uploadedKey ? [uploadedKey] : []),
		...(photoProbeKey ? [photoProbeKey] : []),
		...msFiles.map((entry) => entry.id)
	];
	const remaining = await probeRowCount(probes).catch(() => -1);
	check('probe rows are gone after cleanup', remaining === 0, `remaining=${remaining}`);
	const leftoverKeys = [
		orphanKey,
		galleryKey,
		guardKey,
		...(photoProbeKey ? [photoProbeKey] : []),
		...msFiles.map((entry) => entry.key)
	];
	const leftoverObjects = (await Promise.all(leftoverKeys.map((key) => storage.head(key)))).filter(
		(head) => head !== null
	).length;
	check('probe objects are gone after cleanup', leftoverObjects === 0, `left=${leftoverObjects}`);
	console.log(`\nchecks=${checks} skipped=${skipped} failures=${failures}`);
	await sql.end();
	process.exit(failures === 0 ? 0 : 1);
}

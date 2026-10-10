import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { drafts, files, notes, photos, posts } from '$lib/server/db/content';
import type { FileStatus } from '$lib/server/db/content/file.schema';
import { fileReferences } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { getOption } from '$lib/server/config/options-registry';
import { VARIANT_NAMES, objectKeyFor, variantKeyFor } from '$lib/media/keys';
import type { ObjectStoragePort } from '$lib/server/storage/port';
import { processImage, readImageSize } from '$lib/server/media/variants';
import {
	MAX_BATCH_COUNT,
	MAX_UPLOAD_BYTES,
	sniffUpload,
	type UploadKind
} from '$lib/server/media/sniff';

/**
 * Content assets service (storage line §4.2 / §4.6, ST-1): the synchronous
 * upload pipeline (validate → sha256 → dedupe → media variants → PUT objects
 * → registry row, zero orphans), reference-guarded deletion, the admin list,
 * the three-check audit and the TTL purge. The editor wiring that scans saved
 * content for `/i/<key>` keys lands with ST-3; the status machine values
 * (`pending` → `attached` → `detached`) are already respected here.
 *
 * The db handle and the storage port are injectable (defaults resolved
 * lazily). Besides testability this keeps the module importable from plain
 * tsx scripts — the app `db` reads `$env/dynamic/private`, which exists only
 * inside the SvelteKit runtime (the same constraint the jobs line documents).
 */

/** Structural handle over the app db, mirroring the jobs-line pattern. */
export type FilesDb = Pick<
	typeof import('$lib/server/db').db,
	'select' | 'insert' | 'update' | 'delete' | '$count' | 'transaction'
>;

export interface FilesDeps {
	storage?: ObjectStoragePort;
	db?: FilesDb;
}

async function resolveDeps(
	deps: FilesDeps
): Promise<{ storage: ObjectStoragePort; database: FilesDb }> {
	const storage = deps.storage ?? (await import('$lib/server/storage')).getStorage();
	const database = deps.db ?? (await import('$lib/server/db')).db;
	return { storage, database };
}

export type UploadErrorCode = 'empty' | 'too-large' | 'unsupported-type' | 'batch-too-large';

export class UploadRejected extends Error {
	constructor(
		readonly code: UploadErrorCode,
		message: string
	) {
		super(message);
		this.name = 'UploadRejected';
	}
}

export interface UploadInput {
	fileName: string;
	bytes: Uint8Array;
	uploadedBy?: string | null;
}

export interface UploadedFile {
	id: string;
	objectKey: string;
	fileName: string;
	mimeType: string;
	byteSize: number;
	width: number | null;
	height: number | null;
	status: FileStatus;
	deduplicated: boolean;
}

/** Object-key builders/parser live in `$lib/media/keys` (single source). */

const ROW_FIELDS = {
	id: files.id,
	objectKey: files.objectKey,
	fileName: files.fileName,
	mimeType: files.mimeType,
	byteSize: files.byteSize,
	width: files.width,
	height: files.height,
	status: files.status
} as const;

async function findFileByHash(
	contentHash: string,
	database: FilesDb
): Promise<Omit<UploadedFile, 'deduplicated'> | null> {
	const [row] = await database
		.select(ROW_FIELDS)
		.from(files)
		.where(eq(files.contentHash, contentHash))
		.limit(1);
	return row ? { ...row, status: row.status as FileStatus } : null;
}

/** True when a canonical object key is registered — the /i attachment gate. */
export async function isRegisteredKey(objectKey: string, deps: FilesDeps = {}): Promise<boolean> {
	const { database } = await resolveDeps(deps);
	const [row] = await database
		.select({ id: files.id })
		.from(files)
		.where(eq(files.objectKey, objectKey))
		.limit(1);
	return Boolean(row);
}

async function deleteObjectAndVariants(
	objectKey: string,
	storage: ObjectStoragePort
): Promise<void> {
	for (const key of [objectKey, ...VARIANT_NAMES.map((name) => variantKeyFor(objectKey, name))]) {
		await storage.delete(key);
	}
}

/**
 * Synchronous upload (plan §4.2). Zero orphans by construction:
 * - an object-store failure aborts before any registry write;
 * - a registry failure compensates by deleting everything this attempt put;
 * - a concurrent duplicate (unique `content_hash` race) reuses the winner's
 *   row and does NOT delete objects — content-addressed keys are shared.
 */
export async function uploadFile(input: UploadInput, deps: FilesDeps = {}): Promise<UploadedFile> {
	if (input.bytes.byteLength === 0) {
		throw new UploadRejected('empty', 'Empty uploads are rejected');
	}
	if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
		throw new UploadRejected('too-large', `Uploads must be ≤ ${MAX_UPLOAD_BYTES} bytes`);
	}
	const sniffed = sniffUpload(input.fileName, input.bytes);
	if (!sniffed) {
		throw new UploadRejected('unsupported-type', `Unsupported upload: ${input.fileName}`);
	}

	const { storage, database } = await resolveDeps(deps);
	const contentHash = createHash('sha256').update(input.bytes).digest('hex');
	const existing = await findFileByHash(contentHash, database);
	if (existing) {
		// A dedupe hit is a USE: refresh the last-event anchor so the TTL
		// purge (pending anchors on updated_at since the round-3 ruling)
		// never deletes content that was handed out moments ago. The touch
		// must be CONFIRMED (review round 1): if a purge deleted the row
		// between the lookup and the touch, the update hits 0 rows and we
		// fall through to a fresh insert — reporting a deleted row as a
		// dedupe hit would hand callers a file whose bytes are gone.
		const touched = await database
			.update(files)
			.set({ updatedAt: new Date() })
			.where(eq(files.id, existing.id))
			.returning({ id: files.id });
		if (touched.length > 0) return { ...existing, deduplicated: true };
	}

	const objectKey = objectKeyFor(contentHash, sniffed.ext);
	// Plan §4.3: GIF is a pass-through format — no transcode; the original IS
	// the public tier (GIF carries no EXIF, so there is nothing to strip).
	// Only its header is read for dimensions; no variants are derived.
	const isGif = sniffed.kind === 'image' && sniffed.ext === 'gif';
	const processed = sniffed.kind === 'image' && !isGif ? await processImage(input.bytes) : null;
	const gifSize = isGif ? await readImageSize(input.bytes) : null;

	const putKeys: string[] = [];
	const putObject = async (key: string, data: Uint8Array, contentType: string): Promise<void> => {
		await storage.put(key, data, { contentType });
		putKeys.push(key);
	};

	try {
		await putObject(objectKey, input.bytes, sniffed.mimeType);
		if (processed) {
			await putObject(variantKeyFor(objectKey, 'thumb'), processed.variants.thumb, 'image/webp');
			if (processed.variants.preview) {
				await putObject(
					variantKeyFor(objectKey, 'preview'),
					processed.variants.preview,
					'image/webp'
				);
			}
			await putObject(variantKeyFor(objectKey, 'full'), processed.variants.full, 'image/webp');
		}

		const [row] = await database
			.insert(files)
			.values({
				objectKey,
				contentHash,
				fileName: input.fileName,
				mimeType: sniffed.mimeType,
				byteSize: input.bytes.byteLength,
				width: processed?.width ?? gifSize?.width ?? null,
				height: processed?.height ?? gifSize?.height ?? null,
				thumbhash: processed?.thumbhash ?? null,
				palette: processed ? { ...processed.palette } : null,
				uploadedBy: input.uploadedBy ?? null
			})
			.returning(ROW_FIELDS);
		return { ...row!, status: row!.status as FileStatus, deduplicated: false };
	} catch (cause) {
		// Before touching content-addressed (SHARED) objects, re-check whether
		// a row exists for this hash. Either the racing insert won (23505) or
		// our own insert committed with a lost response — both mean the bytes
		// are live. A re-check that CANNOT run (the same outage that broke the
		// insert) must not be read as "no winner": a stranded object is
		// recoverable, deleted shared bytes are not.
		const recheck = await findFileByHash(contentHash, database).then(
			(row): { state: 'row'; row: Omit<UploadedFile, 'deduplicated'> } | { state: 'none' } =>
				row ? { state: 'row', row } : { state: 'none' },
			(): { state: 'unavailable' } => ({ state: 'unavailable' })
		);
		if (recheck.state === 'unavailable') throw cause;
		if (recheck.state === 'row') {
			// Keys are shared only when the extension matches: the extension is
			// part of the key identity, so a same-family different-ext loser
			// (jpg vs jpeg, txt vs md) owns objects the winner does not
			// reference — delete exactly those, keep the shared ones.
			const winnerKeys = new Set([
				recheck.row.objectKey,
				...VARIANT_NAMES.map((name) => variantKeyFor(recheck.row.objectKey, name))
			]);
			await Promise.allSettled(
				putKeys.filter((key) => !winnerKeys.has(key)).map((key) => storage.delete(key))
			);
			// A lost race is still a USE (round-2 review): refresh the
			// winner's TTL anchor like the happy dedupe path. Best-effort —
			// the bytes are already live and the anchor is only purge input;
			// failures are logged, never silent.
			const touched = await database
				.update(files)
				.set({ updatedAt: new Date() })
				.where(eq(files.id, recheck.row.id))
				.returning({ id: files.id })
				.catch((touchError: unknown) => {
					console.warn('[files] dedupe winner touch failed', {
						fileId: recheck.row.id,
						error: touchError instanceof Error ? touchError.name : typeof touchError
					});
					return [] as { id: string }[];
				});
			if (touched.length === 0) {
				console.warn('[files] dedupe winner vanished before the anchor touch', {
					fileId: recheck.row.id
				});
			}
			return { ...recheck.row, deduplicated: true };
		}
		await Promise.allSettled(putKeys.map((key) => storage.delete(key)));
		throw cause;
	}
}

export interface BatchUploadResult {
	fileName: string;
	ok: boolean;
	file?: UploadedFile;
	code?: UploadErrorCode;
	message?: string;
}

/** Batch wrapper (plan §4.2): per-item report, at most MAX_BATCH_COUNT items. */
export async function uploadFiles(
	inputs: UploadInput[],
	deps: FilesDeps = {}
): Promise<BatchUploadResult[]> {
	if (inputs.length > MAX_BATCH_COUNT) {
		throw new UploadRejected('batch-too-large', `At most ${MAX_BATCH_COUNT} files per batch`);
	}
	const results: BatchUploadResult[] = [];
	for (const input of inputs) {
		try {
			results.push({ fileName: input.fileName, ok: true, file: await uploadFile(input, deps) });
		} catch (error) {
			if (error instanceof UploadRejected) {
				results.push({
					fileName: input.fileName,
					ok: false,
					code: error.code,
					message: error.message
				});
			} else {
				// Raw driver messages (SQL + bound params) never reach the UI or
				// the logs — same policy as the global handleError. Keep a
				// sanitized line server-side, surface only the PG code.
				const code = pgErrorCode(error);
				console.warn('[files] upload failed', {
					fileName: input.fileName,
					error: error instanceof Error ? error.name : typeof error,
					code: code ?? null
				});
				results.push({
					fileName: input.fileName,
					ok: false,
					message: code ? `upload failed (${code})` : 'upload failed'
				});
			}
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Registry queries (admin list / audit / purge)
// ---------------------------------------------------------------------------

export const FILE_LIST_LIMIT = 200;
/** Guard for the text-scanning audit phases (§11: paginate as content grows). */
const SCAN_LIMIT = 2000;

export interface FileListFilters {
	kind?: UploadKind;
	status?: FileStatus;
	keyword?: string;
	/** Only rows created at/after this instant (§6.1 time filter). */
	since?: Date;
	/** Only purgeable orphans: no refs, not a photo, past the media.purge TTL. */
	orphan?: boolean;
}

export interface FileListRow {
	id: string;
	objectKey: string;
	fileName: string;
	mimeType: string;
	byteSize: number;
	width: number | null;
	height: number | null;
	status: FileStatus;
	createdAt: Date;
	refCount: number;
	isInGallery: boolean;
}

const REF_COUNT_SQL = sql<number>`(select count(*)::int from ${fileReferences} where ${fileReferences.fileId} = ${files.id})`;
const IN_GALLERY_SQL = sql<boolean>`exists (select 1 from ${photos} where ${photos.fileId} = ${files.id})`;

/**
 * Expiry instant for a row under the current TTLs — the ordering key shared
 * by the purge sweep and the admin "orphan" view. Anchor = LAST event
 * (pending: updated_at, refreshed by dedupe hits; detached: detached_at).
 */
function purgeExpiresAt(pendingDays: number, detachedDays: number) {
	return sql`(case when ${files.status} = 'detached'
		then coalesce(${files.detachedAt}, ${files.updatedAt}) + make_interval(days => ${detachedDays})
		else ${files.updatedAt} + make_interval(days => ${pendingDays}) end)`;
}

export async function listFiles(
	filters: FileListFilters = {},
	deps: FilesDeps = {}
): Promise<FileListRow[]> {
	const { database } = await resolveDeps(deps);
	const conditions = [];
	if (filters.kind === 'image') conditions.push(like(files.mimeType, 'image/%'));
	if (filters.kind === 'file') conditions.push(sql`${files.mimeType} not like 'image/%'`);
	if (filters.status) conditions.push(eq(files.status, filters.status));
	const keyword = filters.keyword?.trim();
	if (keyword) {
		// Escape LIKE metacharacters so an operator typing `_`/`%` reads them
		// literally instead of silently matching everything.
		const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
		conditions.push(sql`${files.fileName} ilike ${pattern} escape '\\'`);
	}
	if (filters.since && !Number.isNaN(filters.since.getTime())) {
		conditions.push(sql`${files.createdAt} >= ${filters.since}`);
	}
	let orphanOrder: ReturnType<typeof purgeExpiresAt> | null = null;
	if (filters.orphan) {
		// §6.1 "游离" filter — the same criteria as listPurgeCandidates; keep
		// the two in sync when the TTL semantics change.
		const { pendingDays, detachedDays } = await getOption('media.purge', database);
		conditions.push(
			sql`${files.status} in ('pending', 'detached')`,
			sql`(select count(*) from ${fileReferences} where ${fileReferences.fileId} = ${files.id}) = 0`,
			sql`not exists (select 1 from ${photos} where ${photos.fileId} = ${files.id})`,
			sql`(
				(${files.status} = 'pending' and ${files.updatedAt} <= now() - make_interval(days => ${pendingDays}))
				or (${files.status} = 'detached' and coalesce(${files.detachedAt}, ${files.updatedAt}) <= now() - make_interval(days => ${detachedDays}))
			)`
		);
		orphanOrder = purgeExpiresAt(pendingDays, detachedDays);
	}

	const rows = await database
		.select({
			id: files.id,
			objectKey: files.objectKey,
			fileName: files.fileName,
			mimeType: files.mimeType,
			byteSize: files.byteSize,
			width: files.width,
			height: files.height,
			status: files.status,
			createdAt: files.createdAt,
			refCount: REF_COUNT_SQL,
			isInGallery: IN_GALLERY_SQL
		})
		.from(files)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(orphanOrder ?? desc(files.createdAt))
		.limit(FILE_LIST_LIMIT);
	return rows.map((row) => ({ ...row, status: row.status as FileStatus }));
}

export type DeleteFileResult =
	| { kind: 'ok'; objectKey: string }
	| { kind: 'not-found' }
	| { kind: 'referenced'; refCount: number; isInGallery: boolean }
	/**
	 * Still mentioned by stored content (`/i/<key>`) — the transition guard.
	 * `scanTruncated` marks a fail-closed refusal (round-2 review): the scan
	 * hit its row cap, so a clean sweep no longer proves the key is unused.
	 */
	| { kind: 'mentioned'; scanTruncated?: boolean }
	/** Purge only: the row was USED (anchor refreshed) after the snapshot. */
	| { kind: 'reused' };

export interface DeleteFileOptions {
	/**
	 * Purge-only anchor re-verify (review round 1): candidates are selected
	 * from a snapshot, then a mention scan runs before the delete loop — a
	 * dedupe USE landing in that window refreshes `updated_at` and must
	 * abort this deletion. Pass the TTL cutoff the candidate was judged by.
	 */
	requireUnusedSince?: Date;
	/**
	 * Purge-only: purgeMedia already ran the mention scan for its whole
	 * candidate set; re-scanning per candidate would multiply the cost.
	 */
	skipMentionScan?: boolean;
}

/**
 * Reference-guarded delete (§6.3, T15): a file referenced by content or linked
 * to a photo is never removed silently. The re-check and the delete run in a
 * single transaction that locks the registry row first (`FOR UPDATE`): an FK
 * check on a concurrent `file_references`/`photos` INSERT takes an implicit
 * `FOR KEY SHARE` lock on the same row, so the two serialize — either the
 * re-check sees the committed reference (delete blocked), or the racing
 * INSERT waits for this transaction and then fails (23503, row already gone),
 * which the ST-3 writer contract reads as "file removed". Read Committed
 * gives every statement a fresh snapshot, so a reference committed while we
 * waited for the lock is visible to the re-check.
 *
 * Objects go first and the registry row last. The DB half is transactional
 * (a failure after the row delete rolls back), but object deletes are NOT:
 * a crash between the object sweep and the row delete leaves a row whose
 * objects are gone — audit check ③ surfaces that state and a re-run stays
 * retryable. The row lock is held across those storage DELETEs by design
 * (round-3 review: the old comment overclaimed).
 */
export async function deleteFile(
	id: string,
	options: DeleteFileOptions = {},
	deps: FilesDeps = {}
): Promise<DeleteFileResult> {
	const { storage, database } = await resolveDeps(deps);

	// Transition guard (§6.3 "没有静默删除", review round 1): until the ST-3
	// reference backfill lands, an `/i/<key>` mention in stored content is
	// the only in-use signal. The admin delete path used to skip this guard
	// entirely (only purgeMedia had it), so a file referenced by a post body
	// could be deleted silently. Scans are shared with the audit.
	//
	// Residual window (round-3 review, registered): the scan runs BEFORE the
	// transaction, so a mention committed between the scan and the row lock
	// is not seen — best-effort until the ST-3 reference backfill closes it
	// (plan §11).
	if (!options.skipMentionScan) {
		const { mentions, truncated } = await scanMentions(database);
		const [row] = await database
			.select({ objectKey: files.objectKey })
			.from(files)
			.where(eq(files.id, id))
			.limit(1);
		const hit = Boolean(row && mentions.some((mention) => mention.key === row.objectKey));
		// Fail closed on a truncated scan (round-2 review, §6.3): once content
		// outgrows the scan cap a clean sweep no longer proves the key unused.
		if (hit || truncated) {
			return truncated ? { kind: 'mentioned', scanTruncated: true } : { kind: 'mentioned' };
		}
	}

	return database.transaction(async (tx): Promise<DeleteFileResult> => {
		const [row] = await tx
			.select({
				id: files.id,
				objectKey: files.objectKey,
				status: files.status,
				detachedAt: files.detachedAt,
				updatedAt: files.updatedAt
			})
			.from(files)
			.where(eq(files.id, id))
			.limit(1)
			.for('update');
		if (!row) return { kind: 'not-found' };

		if (options.requireUnusedSince) {
			// Same anchor the candidate was judged by (round-2 review): a
			// detached row's TTL runs on detached_at; comparing updated_at
			// alone could clear a row the purge had already ruled too fresh.
			const anchor = row.status === 'detached' ? (row.detachedAt ?? row.updatedAt) : row.updatedAt;
			if (anchor > options.requireUnusedSince) return { kind: 'reused' };
		}

		const [refCount, photoCount] = await Promise.all([
			tx.$count(fileReferences, eq(fileReferences.fileId, id)),
			tx.$count(photos, eq(photos.fileId, id))
		]);
		if (refCount > 0 || photoCount > 0) {
			return { kind: 'referenced', refCount, isInGallery: photoCount > 0 };
		}

		await deleteObjectAndVariants(row.objectKey, storage);
		await tx.delete(files).where(eq(files.id, id));
		return { kind: 'ok', objectKey: row.objectKey };
	});
}

export interface PurgeCandidate {
	id: string;
	objectKey: string;
	fileName: string;
	status: FileStatus;
	ageDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purge candidates (§4.6): never-referenced `pending`/`detached` rows past
 * their TTL (`media.purge` option: 7 / 30 days). Photos-linked files and rows
 * with any content reference are excluded outright.
 */
export async function listPurgeCandidates(deps: FilesDeps = {}): Promise<PurgeCandidate[]> {
	const { database } = await resolveDeps(deps);
	const { pendingDays, detachedDays } = await getOption('media.purge', database);
	const rows = await database
		.select({
			id: files.id,
			objectKey: files.objectKey,
			fileName: files.fileName,
			status: files.status,
			createdAt: files.createdAt,
			detachedAt: files.detachedAt,
			updatedAt: files.updatedAt
		})
		.from(files)
		.where(
			and(
				sql`${files.status} in ('pending', 'detached')`,
				sql`(select count(*) from ${fileReferences} where ${fileReferences.fileId} = ${files.id}) = 0`,
				sql`not exists (select 1 from ${photos} where ${photos.fileId} = ${files.id})`
			)
		)
		// Most-overdue-first by true expiry instant (anchor + its TTL): a
		// created_at ordering starved long-detached rows behind newer ones
		// (round-2 review). §11: page once the registry outgrows the cap.
		.orderBy(purgeExpiresAt(pendingDays, detachedDays))
		.limit(500);

	const now = Date.now();
	const candidates: PurgeCandidate[] = [];
	for (const row of rows) {
		const since = row.status === 'detached' ? (row.detachedAt ?? row.updatedAt) : row.updatedAt;
		const ageDays = (now - new Date(since).getTime()) / DAY_MS;
		const ttl = row.status === 'detached' ? detachedDays : pendingDays;
		if (ageDays >= ttl) {
			candidates.push({
				id: row.id,
				objectKey: row.objectKey,
				fileName: row.fileName,
				status: row.status as FileStatus,
				ageDays: Math.floor(ageDays)
			});
		}
	}
	return candidates;
}

export interface PurgeFailure {
	objectKey: string;
	/** Sanitized reason (error name only — never driver messages). */
	reason: string;
}

/** Why a candidate was kept — never a silent drop (round-2 review). */
export type PurgeSkipReason = 'mentioned' | 'reused' | 'referenced' | 'gone' | 'scan-truncated';

export interface PurgeSkip {
	objectKey: string;
	reason: PurgeSkipReason;
}

export interface PurgeOutcome {
	dryRun: boolean;
	candidates: PurgeCandidate[];
	/**
	 * Candidates kept, each tagged with its reason: `mentioned` (content
	 * still references the key), `reused` (a dedupe use refreshed the anchor
	 * after the snapshot), `referenced` (references appeared between listing
	 * and delete), `gone` (row vanished — concurrent purge), `scan-truncated`
	 * (the mention scan hit its cap: fail-closed, §6.3).
	 */
	skipped: PurgeSkip[];
	/** Deletions that failed (objects kept, row kept — retryable). */
	failed: PurgeFailure[];
	deleted: string[];
	/** True when the mention scan hit its row cap — the guard may be partial. */
	scanTruncated: boolean;
}

/**
 * `purge-media` (§4.6): dry-run first by contract; deletion re-checks
 * references AND refuses keys still mentioned by stored content. Until the
 * ST-3 reference scan backfills `file_references` (registered §11 hold), an
 * md mention is the only signal a file is in use — dry-run output alone
 * would otherwise mark freshly referenced uploads as orphans.
 */
export async function purgeMedia(
	options: { dryRun: boolean },
	deps: FilesDeps = {}
): Promise<PurgeOutcome> {
	const { storage, database } = await resolveDeps(deps);
	const candidates = await listPurgeCandidates({ storage, db: database });
	const { mentions, truncated } = await scanMentions(database);
	const mentioned = new Set(mentions.map((mention) => mention.key));
	const { pendingDays, detachedDays } = await getOption('media.purge', database);
	const now = Date.now();

	const skipped: PurgeSkip[] = candidates
		.filter((candidate) => mentioned.has(candidate.objectKey))
		.map((candidate) => ({ objectKey: candidate.objectKey, reason: 'mentioned' as const }));

	// Fail-closed (round-2 review, §6.3): a truncated scan cannot clear ANY
	// candidate — the un-scanned tail may still mention it.
	if (truncated) {
		for (const candidate of candidates) {
			if (!mentioned.has(candidate.objectKey)) {
				skipped.push({ objectKey: candidate.objectKey, reason: 'scan-truncated' });
			}
		}
	}

	const deleted: string[] = [];
	const failed: PurgeFailure[] = [];

	if (!options.dryRun && !truncated) {
		for (const candidate of candidates) {
			if (mentioned.has(candidate.objectKey)) continue;
			// Anchor re-verify (review round 1): a dedupe USE landing after
			// the snapshot refreshes updated_at; the recorded TTL cutoff
			// turns that into `reused` → skipped, never deleted.
			const ttlDays = candidate.status === 'detached' ? detachedDays : pendingDays;
			const cutoff = new Date(now - ttlDays * DAY_MS);
			try {
				const result = await deleteFile(
					candidate.id,
					{ requireUnusedSince: cutoff, skipMentionScan: true },
					{ storage, db: database }
				);
				if (result.kind === 'ok') deleted.push(candidate.objectKey);
				else if (result.kind === 'reused')
					skipped.push({ objectKey: candidate.objectKey, reason: 'reused' });
				else if (result.kind === 'referenced')
					skipped.push({ objectKey: candidate.objectKey, reason: 'referenced' });
				else if (result.kind === 'not-found')
					skipped.push({ objectKey: candidate.objectKey, reason: 'gone' });
				else skipped.push({ objectKey: candidate.objectKey, reason: 'mentioned' });
			} catch (error) {
				failed.push({
					objectKey: candidate.objectKey,
					reason: error instanceof Error ? error.name : 'unknown'
				});
			}
		}
	}
	return { dryRun: options.dryRun, candidates, skipped, failed, deleted, scanTruncated: truncated };
}

// ---------------------------------------------------------------------------
// Three-check audit (§4.6: orphan / broken link / missing object)
// ---------------------------------------------------------------------------

export interface BrokenLink {
	refType: string;
	refId: string;
	key: string;
}

export interface MissingObject {
	id: string;
	objectKey: string;
	fileName: string;
}

export interface MediaAuditReport {
	generatedAt: string;
	/** ① no reference, not in the gallery, past TTL. */
	orphans: PurgeCandidate[];
	/** ② content mentions `/i/<key>` but no registry row exists. */
	brokenLinks: BrokenLink[];
	/** ③ registry row exists but the object is absent from storage. */
	missingObjects: MissingObject[];
	scannedSources: { posts: number; drafts: number; notes: number };
	/** True when any scan hit its row cap — results may be incomplete. */
	truncated: boolean;
}

const I_KEY_PATTERN =
	/\/i\/([0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)(?:@(?:thumb|preview|full))?/g;

interface MentionScan {
	/** Every `/i/<key>` mention in stored content (variant suffix stripped). */
	mentions: BrokenLink[];
	counts: { posts: number; drafts: number; notes: number };
	truncated: boolean;
}

/**
 * Content mention scan shared by the read-only audit (check ②) and the
 * purge guard. `pages` joins once its P0 remodel lands (§11 registration).
 */
async function scanMentions(database: FilesDb): Promise<MentionScan> {
	const postRows = await database
		.select({ id: posts.id, content: posts.content })
		.from(posts)
		.limit(SCAN_LIMIT);
	const draftRows = await database
		.select({ id: drafts.id, content: drafts.content })
		.from(drafts)
		.limit(SCAN_LIMIT);
	const noteRows = await database
		.select({ id: notes.id, content: notes.content })
		.from(notes)
		.limit(SCAN_LIMIT);

	const mentions: BrokenLink[] = [];
	const collect = (refType: string, rows: Array<{ id: string; content: string | null }>) => {
		for (const row of rows) {
			if (!row.content) continue;
			for (const match of row.content.matchAll(I_KEY_PATTERN)) {
				mentions.push({ refType, refId: row.id, key: match[1] });
			}
		}
	};
	collect('post', postRows);
	collect('draft', draftRows);
	collect('note', noteRows);

	return {
		mentions,
		counts: { posts: postRows.length, drafts: draftRows.length, notes: noteRows.length },
		truncated:
			postRows.length >= SCAN_LIMIT ||
			draftRows.length >= SCAN_LIMIT ||
			noteRows.length >= SCAN_LIMIT
	};
}

/**
 * Read-only sweep (T6). Broken-link detection reuses the shared mention scan
 * within SCAN_LIMIT rows per source; `truncated` reports any cap hit.
 */
export async function runMediaAudit(deps: FilesDeps = {}): Promise<MediaAuditReport> {
	const { storage, database } = await resolveDeps(deps);

	const { mentions, counts, truncated: sourcesTruncated } = await scanMentions(database);

	const keys = [...new Set(mentions.map((mention) => mention.key))];
	let brokenLinks: BrokenLink[] = [];
	if (keys.length > 0) {
		// No LIMIT here: equality/IN against the unique object_key index. A cap
		// used to silently turn existing keys into false broken links
		// (round-2 review).
		const known = await database
			.select({ objectKey: files.objectKey })
			.from(files)
			.where(inArray(files.objectKey, keys));
		const knownKeys = new Set(known.map((row) => row.objectKey));
		brokenLinks = mentions.filter((mention) => !knownKeys.has(mention.key));
	}

	const registryRows = await database
		.select({ id: files.id, objectKey: files.objectKey, fileName: files.fileName })
		.from(files)
		.limit(SCAN_LIMIT);
	const missingObjects: MissingObject[] = [];
	for (const row of registryRows) {
		const head = await storage.head(row.objectKey);
		if (!head) missingObjects.push(row);
	}

	return {
		generatedAt: new Date().toISOString(),
		orphans: await listPurgeCandidates({ storage, db: database }),
		brokenLinks,
		missingObjects,
		scannedSources: counts,
		truncated: sourcesTruncated || registryRows.length >= SCAN_LIMIT
	};
}

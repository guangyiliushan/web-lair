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
	'select' | 'insert' | 'update' | 'delete' | '$count'
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
		// never deletes content that was handed out moments ago.
		await database.update(files).set({ updatedAt: new Date() }).where(eq(files.id, existing.id));
		return { ...existing, deduplicated: true };
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
	| { kind: 'referenced'; refCount: number; isInGallery: boolean };

/**
 * Reference-guarded delete (§6.3): a file referenced by content or linked to
 * a photo is never removed silently. Objects go first and the registry row
 * last, so a partial failure stays retryable and the audit can see it.
 *
 * Known window (registered §11): the reference count and the row delete are
 * not one transaction, so a `file_references` INSERT racing this check would
 * be cascaded away by the delete. Nothing writes refs until ST-3 — that
 * wiring must wrap the re-check and the row delete in a `FOR UPDATE`
 * transaction before references go live.
 */
export async function deleteFile(id: string, deps: FilesDeps = {}): Promise<DeleteFileResult> {
	const { storage, database } = await resolveDeps(deps);
	const [row] = await database
		.select({ id: files.id, objectKey: files.objectKey })
		.from(files)
		.where(eq(files.id, id))
		.limit(1);
	if (!row) return { kind: 'not-found' };

	const [refCount, photoCount] = await Promise.all([
		database.$count(fileReferences, eq(fileReferences.fileId, id)),
		database.$count(photos, eq(photos.fileId, id))
	]);
	if (refCount > 0 || photoCount > 0) {
		return { kind: 'referenced', refCount, isInGallery: photoCount > 0 };
	}

	await deleteObjectAndVariants(row.objectKey, storage);
	await database.delete(files).where(eq(files.id, id));
	return { kind: 'ok', objectKey: row.objectKey };
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

export interface PurgeOutcome {
	dryRun: boolean;
	candidates: PurgeCandidate[];
	/** Candidates skipped because stored content still mentions their key. */
	skipped: string[];
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

	const skipped = candidates
		.filter((candidate) => mentioned.has(candidate.objectKey))
		.map((candidate) => candidate.objectKey);
	const deleted: string[] = [];
	const failed: PurgeFailure[] = [];

	if (!options.dryRun) {
		for (const candidate of candidates) {
			if (mentioned.has(candidate.objectKey)) continue;
			try {
				const result = await deleteFile(candidate.id, { storage, db: database });
				if (result.kind === 'ok') deleted.push(candidate.objectKey);
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

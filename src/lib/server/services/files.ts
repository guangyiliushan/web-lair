import { createHash } from 'node:crypto';
import { and, desc, eq, ilike, inArray, like, sql } from 'drizzle-orm';
import { drafts, files, notes, photos, posts } from '$lib/server/db/content';
import { fileReferences } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { getOption } from '$lib/server/config/options-registry';
import type { ObjectStoragePort } from '$lib/server/storage/port';
import { processImage } from '$lib/server/media/variants';
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
	'select' | 'insert' | 'delete' | '$count'
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
	status: string;
	deduplicated: boolean;
}

const VARIANT_NAMES = ['thumb', 'preview', 'full'] as const;
type VariantName = (typeof VARIANT_NAMES)[number];

/** Content-addressed object key: `<sha[0:2]>/<sha256>.<ext>` (plan §3.1). */
export function objectKeyFor(contentHash: string, ext: string): string {
	return `${contentHash.slice(0, 2)}/${contentHash}.${ext}`;
}

/** Variant keys append the suffix to the canonical key (plan §3.1). */
export function variantKeyFor(objectKey: string, variant: VariantName): string {
	return `${objectKey}@${variant}`;
}

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
	return row ?? null;
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
	if (existing) return { ...existing, deduplicated: true };

	const objectKey = objectKeyFor(contentHash, sniffed.ext);
	const processed = sniffed.kind === 'image' ? await processImage(input.bytes) : null;

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
				width: processed?.width ?? null,
				height: processed?.height ?? null,
				thumbhash: processed?.thumbhash ?? null,
				palette: processed ? { ...processed.palette } : null,
				uploadedBy: input.uploadedBy ?? null
			})
			.returning(ROW_FIELDS);
		return { ...row!, deduplicated: false };
	} catch (cause) {
		if (pgErrorCode(cause) === '23505') {
			const winner = await findFileByHash(contentHash, database);
			if (winner) return { ...winner, deduplicated: true };
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
				results.push({
					fileName: input.fileName,
					ok: false,
					message: error instanceof Error ? error.message : String(error)
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
/** Guard for the text-scanning audit phases (registered: grow with content). */
const SCAN_LIMIT = 2000;

export interface FileListFilters {
	kind?: UploadKind;
	status?: string;
	keyword?: string;
}

export interface FileListRow {
	id: string;
	objectKey: string;
	fileName: string;
	mimeType: string;
	byteSize: number;
	width: number | null;
	height: number | null;
	status: string;
	thumbhash: string | null;
	createdAt: Date;
	refCount: number;
	isPhoto: boolean;
}

const REF_COUNT_SQL = sql<number>`(select count(*)::int from ${fileReferences} where ${fileReferences.fileId} = ${files.id})`;
const IS_PHOTO_SQL = sql<boolean>`exists (select 1 from ${photos} where ${photos.fileId} = ${files.id})`;

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
	if (keyword) conditions.push(ilike(files.fileName, `%${keyword}%`));

	return database
		.select({
			id: files.id,
			objectKey: files.objectKey,
			fileName: files.fileName,
			mimeType: files.mimeType,
			byteSize: files.byteSize,
			width: files.width,
			height: files.height,
			status: files.status,
			thumbhash: files.thumbhash,
			createdAt: files.createdAt,
			refCount: REF_COUNT_SQL,
			isPhoto: IS_PHOTO_SQL
		})
		.from(files)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(files.createdAt))
		.limit(FILE_LIST_LIMIT);
}

export type DeleteFileResult =
	| { kind: 'ok'; objectKey: string }
	| { kind: 'not-found' }
	| { kind: 'referenced'; refCount: number; isPhoto: boolean };

/**
 * Reference-guarded delete (§6.3): a file referenced by content or linked to
 * a photo is never removed silently. Objects go first and the registry row
 * last, so a partial failure stays retryable and the audit can see it.
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
		return { kind: 'referenced', refCount, isPhoto: photoCount > 0 };
	}

	await deleteObjectAndVariants(row.objectKey, storage);
	await database.delete(files).where(eq(files.id, id));
	return { kind: 'ok', objectKey: row.objectKey };
}

export interface PurgeCandidate {
	id: string;
	objectKey: string;
	fileName: string;
	status: string;
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
		.limit(500);

	const now = Date.now();
	const candidates: PurgeCandidate[] = [];
	for (const row of rows) {
		const since = row.status === 'detached' ? (row.detachedAt ?? row.updatedAt) : row.createdAt;
		const ageDays = (now - new Date(since).getTime()) / DAY_MS;
		const ttl = row.status === 'detached' ? detachedDays : pendingDays;
		if (ageDays >= ttl) {
			candidates.push({
				id: row.id,
				objectKey: row.objectKey,
				fileName: row.fileName,
				status: row.status,
				ageDays: Math.floor(ageDays)
			});
		}
	}
	return candidates;
}

export interface PurgeOutcome {
	dryRun: boolean;
	candidates: PurgeCandidate[];
	deleted: string[];
}

/** `purge-media` (§4.6): dry-run first by contract; deletion re-checks refs. */
export async function purgeMedia(
	options: { dryRun: boolean },
	deps: FilesDeps = {}
): Promise<PurgeOutcome> {
	const candidates = await listPurgeCandidates(deps);
	const deleted: string[] = [];
	if (!options.dryRun) {
		for (const candidate of candidates) {
			const result = await deleteFile(candidate.id, deps);
			if (result.kind === 'ok') deleted.push(candidate.objectKey);
		}
	}
	return { dryRun: options.dryRun, candidates, deleted };
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
}

const I_KEY_PATTERN =
	/\/i\/([0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)(?:@(?:thumb|preview|full))?/g;

/**
 * Read-only sweep (T6). Broken-link detection scans stored markdown for
 * `/i/<key>` mentions (variant suffixes stripped — the registry row is keyed
 * by the canonical key); the scan covers posts, drafts and notes within
 * SCAN_LIMIT rows per source.
 */
export async function runMediaAudit(deps: FilesDeps = {}): Promise<MediaAuditReport> {
	const { storage, database } = await resolveDeps(deps);

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

	const keys = [...new Set(mentions.map((mention) => mention.key))];
	let brokenLinks: BrokenLink[] = [];
	if (keys.length > 0) {
		const known = await database
			.select({ objectKey: files.objectKey })
			.from(files)
			.where(inArray(files.objectKey, keys))
			.limit(SCAN_LIMIT);
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
		orphans: await listPurgeCandidates(deps),
		brokenLinks,
		missingObjects,
		scannedSources: { posts: postRows.length, drafts: draftRows.length, notes: noteRows.length }
	};
}

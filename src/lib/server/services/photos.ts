import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { fileReferences, slugTrackers } from '$lib/server/db/system';
import { files, photoTags, photos, tags, type LocalizedText } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { extractPhotoMetadata } from '$lib/server/media/exif';
import { tagSlug, titleSlug } from '$lib/utils/slug';
import { deleteFile } from './files';
import type { ObjectStoragePort } from '$lib/server/storage/port';

/**
 * Photos domain service (storage line §5/§6.2): gallery CRUD, slug handling
 * with the single-hop 301 tracker contract, the content-reference guard of
 * the files boundary, and the public read surface. The reference-guarded
 * `deleteFile` counterpart lives in `./files` — photo removal never deletes
 * the underlying blob unless the file itself is unreferenced (§6.3:
 * "没有静默删除").
 */

export type PhotosDb = Pick<
	typeof import('$lib/server/db').db,
	'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | '$count' | 'transaction'
>;

export interface PhotosDeps {
	storage?: ObjectStoragePort;
	db?: PhotosDb;
}

async function resolveDeps(
	deps: PhotosDeps
): Promise<{ storage: ObjectStoragePort; database: PhotosDb }> {
	const storage = deps.storage ?? (await import('$lib/server/storage')).getStorage();
	const database = deps.db ?? (await import('$lib/server/db')).db;
	return { storage, database };
}

export const PHOTO_LIST_LIMIT = 200;
const PHOTO_PAGE_DEFAULT = 24;
const PHOTO_PAGE_MAX = 60;

const REF_COUNT_SQL = sql<number>`(select count(*)::int from ${fileReferences} where ${fileReferences.fileId} = ${photos.fileId})`;
const SORT_EXPR = sql`coalesce(${photos.takenAt}, ${photos.createdAt})`;

/** Slug base from a file name: extension off, CJK kept (titleSlug rules). */
export function photoSlugBase(fileName: string): string {
	return titleSlug(fileName.replace(/\.[A-Za-z0-9]+$/, ''));
}

/** drizzle numeric columns take strings; round-trip through Number. */
function numeric(value: number | null): string | null {
	return value === null ? null : String(value);
}

function emptyToNull(value: LocalizedText | null | undefined): LocalizedText | null {
	if (!value) return null;
	return Object.keys(value).length > 0 ? value : null;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function uniquePhotoSlug(database: PhotosDb, base: string): Promise<string> {
	const candidates = [base, ...Array.from({ length: 19 }, (_, index) => `${base}-${index + 2}`)];
	const rows = await database
		.select({ slug: photos.slug })
		.from(photos)
		.where(inArray(photos.slug, candidates));
	const taken = new Set(rows.map((row) => row.slug));
	const free = candidates.find((candidate) => !taken.has(candidate));
	if (free) return free;
	return `${base}-${Date.now().toString(36)}`;
}

/** Attach tag names (create-on-demand by slug; first-writer-wins like tags). */
async function attachTags(database: PhotosDb, photoId: string, names: string[]): Promise<void> {
	const cleaned = [
		...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))
	].slice(0, 30);
	if (cleaned.length === 0) return;
	const tagIds: string[] = [];
	for (const name of cleaned) {
		const slug = tagSlug(name);
		if (!slug) continue;
		const [existing] = await database
			.select({ id: tags.id })
			.from(tags)
			.where(eq(tags.slug, slug))
			.limit(1);
		if (existing) {
			tagIds.push(existing.id);
			continue;
		}
		await database.insert(tags).values({ slug, name }).onConflictDoNothing({ target: tags.slug });
		const [row] = await database
			.select({ id: tags.id })
			.from(tags)
			.where(eq(tags.slug, slug))
			.limit(1);
		if (row) tagIds.push(row.id);
	}
	if (tagIds.length > 0) {
		await database
			.insert(photoTags)
			.values(tagIds.map((tagId) => ({ photoId, tagId })))
			.onConflictDoNothing();
	}
}

export type CreatePhotoResult =
	| { kind: 'ok'; id: string; slug: string }
	| { kind: 'not-found' }
	| { kind: 'not-image' }
	| { kind: 'already-in-gallery'; photoId: string }
	| { kind: 'source-missing' };

export interface CreatePhotoOptions {
	title?: LocalizedText | null;
	/** Tag names, created on demand. */
	tags?: string[];
}

/** Add a registry file to the gallery (`files` row → `photos` row). */
export async function createPhotoFromFile(
	fileId: string,
	options: CreatePhotoOptions = {},
	deps: PhotosDeps = {}
): Promise<CreatePhotoResult> {
	const { storage, database } = await resolveDeps(deps);
	const [file] = await database
		.select({
			id: files.id,
			objectKey: files.objectKey,
			fileName: files.fileName,
			mimeType: files.mimeType
		})
		.from(files)
		.where(eq(files.id, fileId))
		.limit(1);
	if (!file) return { kind: 'not-found' };
	if (!file.mimeType.startsWith('image/')) return { kind: 'not-image' };

	const [existing] = await database
		.select({ id: photos.id })
		.from(photos)
		.where(eq(photos.fileId, fileId))
		.limit(1);
	if (existing) return { kind: 'already-in-gallery', photoId: existing.id };

	const object = await storage.get(file.objectKey);
	if (!object) return { kind: 'source-missing' };
	const bytes = await readStream(object.body);
	const timeZone = await getOption('site.timezone', database);
	const meta = await extractPhotoMetadata(bytes, { timeZone });

	const base = photoSlugBase(file.fileName) || `photo-${fileId.slice(0, 8)}`;
	const slug = await uniquePhotoSlug(database, base);
	const title = emptyToNull(options.title);

	let row: { id: string; slug: string };
	try {
		row = await database.transaction(async (tx) => {
			const [created] = await tx
				.insert(photos)
				.values({
					fileId,
					slug,
					title,
					takenAt: meta.takenAt,
					cameraMake: meta.cameraMake,
					cameraModel: meta.cameraModel,
					lensModel: meta.lensModel,
					fNumber: numeric(meta.fNumber),
					focalLengthMm: numeric(meta.focalLengthMm),
					exposureTimeS: numeric(meta.exposureTimeS),
					iso: meta.iso,
					latitude: numeric(meta.latitude),
					longitude: numeric(meta.longitude),
					altitudeM: numeric(meta.altitudeM),
					exif: meta.exif
				})
				.returning({ id: photos.id, slug: photos.slug });
			if (options.tags && options.tags.length > 0) {
				await attachTags(tx, created!.id, options.tags);
			}
			return created!;
		});
	} catch (caught) {
		// Idempotency under concurrency (T13 live import): the same file can be
		// handed to this service from two directory entries at once (identical
		// bytes) or from a parallel caller. `photos.file_id` is unique, so one
		// side loses the insert; the loser re-reads the winner's row instead of
		// surfacing a raw driver error. A 23505 on the slug (no row for the
		// file) is NOT ours to absorb — rethrow for the caller to classify.
		if (pgErrorCode(caught) === '23505') {
			const [winner] = await database
				.select({ id: photos.id })
				.from(photos)
				.where(eq(photos.fileId, fileId))
				.limit(1);
			if (winner) return { kind: 'already-in-gallery', photoId: winner.id };
		}
		throw caught;
	}
	return { kind: 'ok', id: row.id, slug: row.slug };
}

export type UpdatePhotoResult =
	{ kind: 'ok' } | { kind: 'not-found' } | { kind: 'slug-invalid' } | { kind: 'slug-taken' };

export interface PhotoPatch {
	title?: LocalizedText | null;
	description?: LocalizedText | null;
	slug?: string;
	takenAt?: Date | null;
	isVisible?: boolean;
	/** When present, the tag set is REPLACED by these names. */
	tags?: string[];
}

class PhotoGoneError extends Error {}

/**
 * Metadata edit (§6.2 drawer). Slug changes write a `slug_trackers` row
 * (type `photo`) inside the same transaction — photos are language
 * agnostic, so trackers use the default lang ('en') on both the write side
 * here and the read side in the route resolver.
 */
export async function updatePhoto(
	photoId: string,
	patch: PhotoPatch,
	deps: PhotosDeps = {}
): Promise<UpdatePhotoResult> {
	const { database } = await resolveDeps(deps);
	const [current] = await database
		.select({ id: photos.id, slug: photos.slug })
		.from(photos)
		.where(eq(photos.id, photoId))
		.limit(1);
	if (!current) return { kind: 'not-found' };

	let nextSlug: string | undefined;
	if (patch.slug !== undefined) {
		const normalized = titleSlug(patch.slug);
		if (!normalized) return { kind: 'slug-invalid' };
		nextSlug = normalized;
	}

	try {
		await database.transaction(async (tx) => {
			const set: Record<string, unknown> = {};
			if (patch.title !== undefined) set.title = emptyToNull(patch.title);
			if (patch.description !== undefined) set.description = emptyToNull(patch.description);
			if (patch.takenAt !== undefined) set.takenAt = patch.takenAt;
			if (patch.isVisible !== undefined) set.isVisible = patch.isVisible;
			if (nextSlug !== undefined) set.slug = nextSlug;

			if (Object.keys(set).length > 0) {
				const updated = await tx
					.update(photos)
					.set(set)
					.where(eq(photos.id, photoId))
					.returning({ id: photos.id });
				if (updated.length === 0) throw new PhotoGoneError();
			}
			if (nextSlug !== undefined && nextSlug !== current.slug) {
				await tx.insert(slugTrackers).values({
					slug: current.slug,
					type: 'photo',
					lang: 'en',
					targetId: photoId
				});
			}
			if (patch.tags !== undefined) {
				await tx.delete(photoTags).where(eq(photoTags.photoId, photoId));
				await attachTags(tx, photoId, patch.tags);
			}
		});
	} catch (caught) {
		if (caught instanceof PhotoGoneError) return { kind: 'not-found' };
		if (pgErrorCode(caught) === '23505') return { kind: 'slug-taken' };
		throw caught;
	}
	return { kind: 'ok' };
}

export type RemovePhotoResult =
	{ kind: 'ok'; fileDeleted: boolean; fileBlocked: boolean } | { kind: 'not-found' };

/**
 * Gallery removal (§6.3): the photo row always goes; the blob only when the
 * caller asks AND the file passes its own reference guard (photos-linked
 * files are never auto-deleted — the guard is re-run, not assumed).
 */
export async function removePhoto(
	photoId: string,
	options: { removeFile?: boolean } = {},
	deps: PhotosDeps = {}
): Promise<RemovePhotoResult> {
	const { storage, database } = await resolveDeps(deps);
	const [current] = await database
		.select({ id: photos.id, fileId: photos.fileId })
		.from(photos)
		.where(eq(photos.id, photoId))
		.limit(1);
	if (!current) return { kind: 'not-found' };

	const deleted = await database
		.delete(photos)
		.where(eq(photos.id, photoId))
		.returning({ id: photos.id });
	if (deleted.length === 0) return { kind: 'not-found' };

	let fileDeleted = false;
	let fileBlocked = false;
	if (options.removeFile) {
		const result = await deleteFile(current.fileId, { storage, db: database });
		fileDeleted = result.kind === 'ok';
		fileBlocked = result.kind === 'referenced';
	}
	return { kind: 'ok', fileDeleted, fileBlocked };
}

/** Append tag names to an existing photo (batch op). */
export async function addPhotoTags(
	photoId: string,
	names: string[],
	deps: PhotosDeps = {}
): Promise<void> {
	const { database } = await resolveDeps(deps);
	await attachTags(database, photoId, names);
}

export interface PhotoListFilters {
	visibility?: boolean;
	hasLocation?: boolean;
	tagId?: string;
	since?: Date;
	slugKeyword?: string;
}

export interface TagChip {
	id: string;
	name: string;
	slug: string;
}

export interface AdminPhotoRow {
	id: string;
	slug: string;
	title: LocalizedText | null;
	description: LocalizedText | null;
	takenAt: Date | null;
	isVisible: boolean;
	createdAt: Date;
	fileId: string;
	objectKey: string;
	fileName: string;
	mimeType: string;
	byteSize: number;
	width: number | null;
	height: number | null;
	thumbhash: string | null;
	palette: unknown;
	refCount: number;
	latitude: string | null;
	longitude: string | null;
	tags: TagChip[];
}

export async function listAdminPhotos(
	filters: PhotoListFilters = {},
	deps: PhotosDeps = {}
): Promise<AdminPhotoRow[]> {
	const { database } = await resolveDeps(deps);
	const conditions = [];
	if (filters.visibility !== undefined) conditions.push(eq(photos.isVisible, filters.visibility));
	if (filters.hasLocation) {
		conditions.push(and(isNotNull(photos.latitude), isNotNull(photos.longitude)));
	}
	if (filters.tagId) {
		conditions.push(
			sql`exists (select 1 from ${photoTags} where ${photoTags.photoId} = ${photos.id} and ${photoTags.tagId} = ${filters.tagId})`
		);
	}
	if (filters.since && !Number.isNaN(filters.since.getTime())) {
		conditions.push(sql`${photos.createdAt} >= ${filters.since}`);
	}
	const keyword = filters.slugKeyword?.trim();
	if (keyword) {
		const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
		conditions.push(sql`${photos.slug} ilike ${pattern} escape '\\'`);
	}

	const rows = await database
		.select({
			id: photos.id,
			slug: photos.slug,
			title: photos.title,
			description: photos.description,
			takenAt: photos.takenAt,
			isVisible: photos.isVisible,
			createdAt: photos.createdAt,
			fileId: photos.fileId,
			objectKey: files.objectKey,
			fileName: files.fileName,
			mimeType: files.mimeType,
			byteSize: files.byteSize,
			width: files.width,
			height: files.height,
			thumbhash: files.thumbhash,
			palette: files.palette,
			refCount: REF_COUNT_SQL,
			latitude: photos.latitude,
			longitude: photos.longitude
		})
		.from(photos)
		.innerJoin(files, eq(photos.fileId, files.id))
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(SORT_EXPR), desc(photos.id))
		.limit(PHOTO_LIST_LIMIT);

	const ids = rows.map((row) => row.id);
	const tagRows =
		ids.length > 0
			? await database
					.select({
						photoId: photoTags.photoId,
						id: tags.id,
						name: tags.name,
						slug: tags.slug
					})
					.from(photoTags)
					.innerJoin(tags, eq(photoTags.tagId, tags.id))
					.where(inArray(photoTags.photoId, ids))
			: [];
	const byPhoto = new Map<string, TagChip[]>();
	for (const row of tagRows) {
		const list = byPhoto.get(row.photoId) ?? [];
		list.push({ id: row.id, name: row.name, slug: row.slug });
		byPhoto.set(row.photoId, list);
	}
	return rows.map((row) => ({ ...row, tags: byPhoto.get(row.id) ?? [] }));
}

/** Tag options for the admin filter bar and the batch tag op. */
export async function listTagOptions(deps: PhotosDeps = {}): Promise<TagChip[]> {
	const { database } = await resolveDeps(deps);
	return database
		.select({ id: tags.id, name: tags.name, slug: tags.slug })
		.from(tags)
		.orderBy(tags.name)
		.limit(300);
}

// ---------------------------------------------------------------------------
// Public read surface (§5) — visibility is `is_visible` only; hidden rows
// 404 on the public face, and the tracker redirect never bypasses this.
// ---------------------------------------------------------------------------

export interface PublicPhotoDetail {
	id: string;
	slug: string;
	title: LocalizedText | null;
	description: LocalizedText | null;
	takenAt: Date | null;
	createdAt: Date;
	cameraMake: string | null;
	cameraModel: string | null;
	lensModel: string | null;
	fNumber: string | null;
	focalLengthMm: string | null;
	exposureTimeS: string | null;
	iso: number | null;
	latitude: string | null;
	longitude: string | null;
	altitudeM: string | null;
	exif: Record<string, unknown> | null;
	objectKey: string;
	fileName: string;
	mimeType: string;
	byteSize: number;
	width: number | null;
	height: number | null;
	thumbhash: string | null;
	palette: unknown;
}

const DETAIL_FIELDS = {
	id: photos.id,
	slug: photos.slug,
	title: photos.title,
	description: photos.description,
	takenAt: photos.takenAt,
	createdAt: photos.createdAt,
	cameraMake: photos.cameraMake,
	cameraModel: photos.cameraModel,
	lensModel: photos.lensModel,
	fNumber: photos.fNumber,
	focalLengthMm: photos.focalLengthMm,
	exposureTimeS: photos.exposureTimeS,
	iso: photos.iso,
	latitude: photos.latitude,
	longitude: photos.longitude,
	altitudeM: photos.altitudeM,
	exif: photos.exif,
	objectKey: files.objectKey,
	fileName: files.fileName,
	mimeType: files.mimeType,
	byteSize: files.byteSize,
	width: files.width,
	height: files.height,
	thumbhash: files.thumbhash,
	palette: files.palette
} as const;

async function loadVisibleDetail(
	where: ReturnType<typeof eq>,
	deps: PhotosDeps
): Promise<PublicPhotoDetail | null> {
	const { database } = await resolveDeps(deps);
	const [row] = await database
		.select(DETAIL_FIELDS)
		.from(photos)
		.innerJoin(files, eq(photos.fileId, files.id))
		.where(and(eq(photos.isVisible, true), where))
		.limit(1);
	return row ?? null;
}

export function getVisiblePhotoBySlug(
	slug: string,
	deps: PhotosDeps = {}
): Promise<PublicPhotoDetail | null> {
	return loadVisibleDetail(eq(photos.slug, slug), deps);
}

export function getVisiblePhotoById(
	id: string,
	deps: PhotosDeps = {}
): Promise<PublicPhotoDetail | null> {
	return loadVisibleDetail(eq(photos.id, id), deps);
}

export interface PhotoNeighbor {
	slug: string;
	title: LocalizedText | null;
}

/**
 * Adjacent visible photos for the viewer. The feed orders by
 * `(sort_at, id) DESC`, so `newer` is the row before the current one (tuple
 * GREATER, first page of the tail) and `older` the row after it. Both sides
 * are single-row keyset reads on the same tuple the list paginates on —
 * hidden rows are filtered identically on both faces.
 */
export async function listPhotoNeighbors(
	current: { sortAt: Date; id: string },
	deps: PhotosDeps = {}
): Promise<{ newer: PhotoNeighbor | null; older: PhotoNeighbor | null }> {
	const { database } = await resolveDeps(deps);
	const sortAt = current.sortAt.toISOString();
	const fields = { slug: photos.slug, title: photos.title };
	const [newerRows, olderRows] = await Promise.all([
		database
			.select(fields)
			.from(photos)
			.where(
				and(
					eq(photos.isVisible, true),
					sql`(${SORT_EXPR}, ${photos.id}) > (${sortAt}::timestamptz, ${current.id}::uuid)`
				)
			)
			.orderBy(sql`${SORT_EXPR} asc, ${photos.id} asc`)
			.limit(1),
		database
			.select(fields)
			.from(photos)
			.where(
				and(
					eq(photos.isVisible, true),
					sql`(${SORT_EXPR}, ${photos.id}) < (${sortAt}::timestamptz, ${current.id}::uuid)`
				)
			)
			.orderBy(sql`${SORT_EXPR} desc, ${photos.id} desc`)
			.limit(1)
	]);
	return { newer: newerRows[0] ?? null, older: olderRows[0] ?? null };
}

export interface PublicPhotoFilters {
	year?: number;
	cameraModel?: string;
	lensModel?: string;
	tagId?: string;
	/** Map view (ST-2d): only rows carrying both coordinates. */
	hasLocation?: boolean;
}

export interface PublicPhotoCursor {
	/** ISO instant of `coalesce(taken_at, created_at)` of the last item. */
	sortAt: string;
	id: string;
}

const PUBLIC_LIST_FIELDS = {
	id: photos.id,
	slug: photos.slug,
	title: photos.title,
	description: photos.description,
	takenAt: photos.takenAt,
	createdAt: photos.createdAt,
	cameraMake: photos.cameraMake,
	cameraModel: photos.cameraModel,
	lensModel: photos.lensModel,
	latitude: photos.latitude,
	longitude: photos.longitude,
	objectKey: files.objectKey,
	fileName: files.fileName,
	mimeType: files.mimeType,
	width: files.width,
	height: files.height,
	thumbhash: files.thumbhash,
	palette: files.palette
} as const;

export type PublicPhotoItem = {
	[K in keyof typeof PUBLIC_LIST_FIELDS]: K extends
		'id' | 'slug' | 'objectKey' | 'fileName' | 'mimeType'
		? string
		: K extends 'width' | 'height'
			? number | null
			: K extends 'thumbhash'
				? string | null
				: K extends 'title' | 'description'
					? LocalizedText | null
					: K extends 'takenAt'
						? Date | null
						: K extends 'createdAt'
							? Date
							: K extends 'latitude' | 'longitude'
								? string | null
								: K extends 'cameraMake' | 'cameraModel' | 'lensModel'
									? string | null
									: unknown;
};

export async function listPublicPhotos(
	filters: PublicPhotoFilters = {},
	cursor: PublicPhotoCursor | null = null,
	limit = PHOTO_PAGE_DEFAULT,
	deps: PhotosDeps = {}
): Promise<PublicPhotoItem[]> {
	const { database } = await resolveDeps(deps);
	const conditions = [eq(photos.isVisible, true)];
	if (filters.year) {
		conditions.push(sql`extract(year from ${SORT_EXPR}) = ${filters.year}`);
	}
	if (filters.cameraModel) conditions.push(eq(photos.cameraModel, filters.cameraModel));
	if (filters.lensModel) conditions.push(eq(photos.lensModel, filters.lensModel));
	if (filters.hasLocation) {
		// `and()` of two defined predicates cannot be undefined; this array is
		// typed SQL<> because it was seeded with the visibility equality.
		conditions.push(and(isNotNull(photos.latitude), isNotNull(photos.longitude))!);
	}
	if (filters.tagId) {
		conditions.push(
			sql`exists (select 1 from ${photoTags} where ${photoTags.photoId} = ${photos.id} and ${photoTags.tagId} = ${filters.tagId})`
		);
	}
	if (cursor) {
		conditions.push(
			sql`(${SORT_EXPR}, ${photos.id}) < (${cursor.sortAt}::timestamptz, ${cursor.id}::uuid)`
		);
	}
	const clamped = Math.min(Math.max(1, Math.trunc(limit)), PHOTO_PAGE_MAX);
	const rows = await database
		.select(PUBLIC_LIST_FIELDS)
		.from(photos)
		.innerJoin(files, eq(photos.fileId, files.id))
		.where(and(...conditions))
		.orderBy(sql`${SORT_EXPR} desc, ${photos.id} desc`)
		.limit(clamped);
	return rows as PublicPhotoItem[];
}

export interface PhotoFacets {
	years: number[];
	cameras: string[];
	lenses: string[];
	tags: TagChip[];
}

/** Filter axes for the public grid (§5.1: time / camera / lens / tags). */
export async function listPhotoFacets(deps: PhotosDeps = {}): Promise<PhotoFacets> {
	const { database } = await resolveDeps(deps);
	const [yearRows, cameraRows, lensRows, tagRows] = await Promise.all([
		database
			.select({ year: sql<number>`extract(year from ${SORT_EXPR})::int` })
			.from(photos)
			.where(eq(photos.isVisible, true))
			.groupBy(sql`extract(year from ${SORT_EXPR})`)
			.orderBy(sql`extract(year from ${SORT_EXPR}) desc`)
			.limit(30),
		database
			.selectDistinct({ value: photos.cameraModel })
			.from(photos)
			.where(and(eq(photos.isVisible, true), isNotNull(photos.cameraModel)))
			.orderBy(photos.cameraModel)
			.limit(50),
		database
			.selectDistinct({ value: photos.lensModel })
			.from(photos)
			.where(and(eq(photos.isVisible, true), isNotNull(photos.lensModel)))
			.orderBy(photos.lensModel)
			.limit(50),
		database
			.select({ id: tags.id, name: tags.name, slug: tags.slug })
			.from(tags)
			.innerJoin(photoTags, eq(photoTags.tagId, tags.id))
			.innerJoin(photos, eq(photoTags.photoId, photos.id))
			.where(eq(photos.isVisible, true))
			.groupBy(tags.id, tags.name, tags.slug)
			.orderBy(tags.name)
			.limit(60)
	]);
	return {
		years: yearRows.map((row) => row.year),
		cameras: cameraRows.map((row) => row.value!).filter(Boolean),
		lenses: lensRows.map((row) => row.value!).filter(Boolean),
		tags: tagRows
	};
}

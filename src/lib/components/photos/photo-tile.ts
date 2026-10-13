import { thumbHashToDataURL } from 'thumbhash';
import { variantKeyFor } from '$lib/media/keys';

/**
 * Client-facing shapes + helpers for the public gallery (§5.1). Deliberately
 * free of `$lib/server` imports so grid/viewer components render in the
 * browser.
 */

export type PhotoTileText = Record<string, string | undefined> | null;

export interface PhotoTile {
	id: string;
	slug: string;
	title: PhotoTileText;
	description: PhotoTileText;
	takenAt: Date | string | null;
	cameraMake: string | null;
	cameraModel: string | null;
	lensModel: string | null;
	objectKey: string;
	fileName: string;
	mimeType: string;
	width: number | null;
	height: number | null;
	thumbhash: string | null;
}

/** First non-blank string: current locale → en → any other language. */
export function photoText(value: PhotoTileText, locale: string): string | null {
	if (!value) return null;
	const direct = value[locale];
	if (typeof direct === 'string' && direct.trim() !== '') return direct;
	const english = value.en;
	if (typeof english === 'string' && english.trim() !== '') return english;
	for (const candidate of Object.values(value)) {
		if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
	}
	return null;
}

/** Display title: localized → en → any → slug. */
export function photoTitle(tile: Pick<PhotoTile, 'title' | 'slug'>, locale: string): string {
	return photoText(tile.title, locale) ?? tile.slug;
}

/** Alt text chain (§5.3): title → description → file name. */
export function photoAlt(
	tile: Pick<PhotoTile, 'title' | 'description' | 'fileName'>,
	locale: string
): string {
	return photoText(tile.title, locale) ?? photoText(tile.description, locale) ?? tile.fileName;
}

/**
 * The photo surface the overlay viewer consumes (3c): the neighbour payload
 * fields plus `byteSize` for the loading policy. The server mirrors it as
 * `PublicViewerPhoto` (type-welded in photos.test.ts), and the page's
 * `PublicPhotoDetail` is a superset.
 */
export interface PhotoViewerSource {
	id: string;
	slug: string;
	title: PhotoTileText;
	description: PhotoTileText;
	objectKey: string;
	fileName: string;
	mimeType: string;
	width: number | null;
	height: number | null;
	thumbhash: string | null;
	byteSize: number | null;
}

/**
 * Public URL for a tile: GIFs are their own public tier, others use variants.
 * Only `mimeType`/`objectKey` are read, so admin rows (and any structural
 * subset) can call it directly — the single source for the tier rule
 * (round-3 review: two copies had drifted into the admin pages).
 */
export function photoTileSrc(
	tile: Pick<PhotoTile, 'mimeType' | 'objectKey'>,
	variant: 'thumb' | 'preview' | 'full'
): string {
	if (tile.mimeType === 'image/gif') return `/i/${tile.objectKey}`;
	return `/i/${variantKeyFor(tile.objectKey, variant)}`;
}

/**
 * The preview box of the variant pipeline, mirrored here because this module
 * is browser-importable while the pipeline's home pulls in sharp. A
 * drift-guard test welds the two values (photo-tile.test.ts imports both).
 */
export const EMBED_PREVIEW_LONG_EDGE = 2560;

/**
 * The body-image URL (Q11, refined by the 3a review round): GIFs and other
 * pass-through formats travel as their bare key; images embed as `@preview`
 * when the pipeline produced one (source long edge above the preview box)
 * and as `@full` otherwise. Below that box `@preview` does not exist, so
 * this choice IS the object-existence rule - an unconditional `@preview`
 * 404s for every reader on nearly every screenshot. Embed URLs always carry
 * a variant suffix; bare non-GIF keys stay admin-only (Q11 constraint).
 */
export function photoEmbedSrc(
	tile: Pick<PhotoTile, 'mimeType' | 'objectKey' | 'width' | 'height'>
): string {
	if (tile.mimeType === 'image/gif' || !tile.mimeType.startsWith('image/')) {
		return `/i/${tile.objectKey}`;
	}
	const longEdge = Math.max(tile.width ?? 0, tile.height ?? 0);
	return `/i/${variantKeyFor(tile.objectKey, longEdge > EMBED_PREVIEW_LONG_EDGE ? 'preview' : 'full')}`;
}

/** Slim shape for the public map markers (ST-2d). */
export interface MapPhoto {
	slug: string;
	title: PhotoTileText;
	latitude: number;
	longitude: number;
}

const THUMBHASH_CACHE = new Map<string, string | null>();
/** Bound the session cache (review round 1): browsing N photos used to
 * accumulate N data-URL strings for the whole session. */
const THUMBHASH_CACHE_MAX = 512;

/** Base64 thumbhash → data URL (cached); garbage hashes resolve to null. */
export function thumbhashDataUrl(hash: string | null): string | null {
	if (!hash) return null;
	const cached = THUMBHASH_CACHE.get(hash);
	if (cached !== undefined) return cached;
	let result: string | null;
	try {
		const binary = atob(hash);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		result = thumbHashToDataURL(bytes);
	} catch {
		result = null;
	}
	if (THUMBHASH_CACHE.size >= THUMBHASH_CACHE_MAX) THUMBHASH_CACHE.clear();
	THUMBHASH_CACHE.set(hash, result);
	return result;
}

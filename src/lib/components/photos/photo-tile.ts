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
export function photoTitle(tile: PhotoTile, locale: string): string {
	return photoText(tile.title, locale) ?? tile.slug;
}

/** Alt text chain (§5.3): title → description → file name. */
export function photoAlt(tile: PhotoTile, locale: string): string {
	return photoText(tile.title, locale) ?? photoText(tile.description, locale) ?? tile.fileName;
}

/** Public URL for a tile: GIFs are their own public tier, others use variants. */
export function photoTileSrc(tile: PhotoTile, variant: 'thumb' | 'preview' | 'full'): string {
	if (tile.mimeType === 'image/gif') return `/i/${tile.objectKey}`;
	return `/i/${variantKeyFor(tile.objectKey, variant)}`;
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

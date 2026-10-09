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
	takenAt: string | null;
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

/** Display title: current locale → en → any → slug. */
export function photoTitle(tile: PhotoTile, locale: string): string {
	const title = tile.title;
	if (title) {
		const direct = title[locale];
		if (typeof direct === 'string' && direct.trim() !== '') return direct;
		for (const value of Object.values(title)) {
			if (typeof value === 'string' && value.trim() !== '') return value;
		}
	}
	return tile.slug;
}

/** Alt text chain (§5.3): title → description → file name. */
export function photoAlt(tile: PhotoTile, locale: string): string {
	const title = photoTitle(tile, locale);
	if (title !== tile.slug) return title;
	const description = tile.description;
	if (description) {
		for (const value of Object.values(description)) {
			if (typeof value === 'string' && value.trim() !== '') return value;
		}
	}
	return tile.fileName;
}

/** Public URL for a tile: GIFs are their own public tier, others use variants. */
export function photoTileSrc(tile: PhotoTile, variant: 'thumb' | 'preview' | 'full'): string {
	if (tile.mimeType === 'image/gif') return `/i/${tile.objectKey}`;
	return `/i/${variantKeyFor(tile.objectKey, variant)}`;
}

const THUMBHASH_CACHE = new Map<string, string | null>();

/** Base64 thumbhash → data URL (cached); garbage hashes resolve to null. */
export function thumbhashDataUrl(hash: string | null): string | null {
	if (!hash) return null;
	const cached = THUMBHASH_CACHE.get(hash);
	if (cached !== undefined) return cached;
	let result: string | null = null;
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
	THUMBHASH_CACHE.set(hash, result);
	return result;
}

import sharp, { type SharpOptions } from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { decodeHeic, isHeic } from './heic';

/** Long-edge boxes for the derived variants (ledger §21 / plan §4.3). */
const THUMB_BOX = 480;
const PREVIEW_BOX = 2560;
const THUMB_QUALITY = 80;
const PREVIEW_QUALITY = 85;
const FULL_QUALITY = 92;

export interface ImageVariants {
	/** 480 box, always generated (lists / thumbnails). */
	thumb: Buffer;
	/** 2560 box; only when the source long edge exceeds 2560. */
	preview: Buffer | null;
	/** Source resolution webp; metadata stripped. */
	full: Buffer;
}

export interface ProcessedImage {
	width: number;
	height: number;
	variants: ImageVariants;
	/** thumbhash of a small RGBA copy, base64 (store on `files.thumbhash`). */
	thumbhash: string;
	/** v1 palette: dominant colour; shape extensible (store on `files.palette`). */
	palette: { dominant: [number, number, number] };
}

/**
 * Image pipeline for ST-1 (ledger §21): HEIC (WASM) and regular inputs are
 * normalised through one sharp chain that
 * - bakes EXIF Orientation into the pixels (`rotate()`), then
 * - derives thumb / preview / full webp variants (fit-within-box, long-edge
 *   discipline, never enlarging, public variants carry no metadata), plus
 * - thumbhash and dominant colour for placeholders.
 *
 * The original bytes are not touched here — the caller archives them as the
 * private original (plan §4.3).
 */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
	const heic = isHeic(input);
	const decoded = heic ? await decodeHeic(input) : null;
	const rawOptions: SharpOptions | undefined = decoded
		? { raw: { width: decoded.width, height: decoded.height, channels: 4 } }
		: undefined;
	const source = decoded ? Buffer.from(decoded.data) : Buffer.from(input);

	const meta = await sharp(source, rawOptions).metadata();
	// heic-decode hands back raw pixels: any container orientation tag has
	// already been resolved, so there is nothing left to swap for.
	const orientation = decoded ? 1 : (meta.orientation ?? 1);
	const swaps = orientation >= 5 && orientation <= 8;
	const width = (swaps ? meta.height : meta.width) ?? 0;
	const height = (swaps ? meta.width : meta.height) ?? 0;
	if (!width || !height) {
		throw new Error('media: unable to read image dimensions');
	}

	const base = sharp(source, rawOptions).rotate();
	const thumb = await base
		.clone()
		.resize({ width: THUMB_BOX, height: THUMB_BOX, fit: 'inside', withoutEnlargement: true })
		.webp({ quality: THUMB_QUALITY })
		.toBuffer();
	const preview =
		Math.max(width, height) > PREVIEW_BOX
			? await base
					.clone()
					.resize({
						width: PREVIEW_BOX,
						height: PREVIEW_BOX,
						fit: 'inside',
						withoutEnlargement: true
					})
					.webp({ quality: PREVIEW_QUALITY })
					.toBuffer()
			: null;
	const full = await base.clone().webp({ quality: FULL_QUALITY }).toBuffer();

	const small = await base
		.clone()
		.resize({ width: 100, height: 100, fit: 'inside' })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const thumbhash = Buffer.from(
		rgbaToThumbHash(small.info.width, small.info.height, new Uint8Array(small.data))
	).toString('base64');

	const stats = await base.clone().stats();
	const dominant = stats.dominant;

	return {
		width,
		height,
		variants: { thumb, preview, full },
		thumbhash,
		palette: { dominant: [Math.round(dominant.r), Math.round(dominant.g), Math.round(dominant.b)] }
	};
}

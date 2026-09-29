import decode from 'heic-decode';

/**
 * HEIC/HEIF detection and decoding (ledger §21). sharp's prebuilt libvips
 * cannot decode HEVC-coded HEIC (issue #4050), so HEIC goes through the
 * libheif WASM build that ships with `heic-decode` (libheif-js ≥1.22 — the
 * CVE-2026-32740/32739 fix line — pinned as a direct dependency).
 */

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * Sniffs the ISO-BMFF `ftyp` box: HEVC-coded brands (heic/heix/hevc/hevx) and
 * HEIF-family brands (mif1/msf1) all route through the WASM decoder.
 */
export function isHeic(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 12) return false;
	const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(4) !== 0x66747970) return false; // 'ftyp'
	const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
	return HEIF_BRANDS.has(brand);
}

export interface DecodedHeic {
	width: number;
	height: number;
	/** RGBA pixels (4 channels per pixel). */
	data: Uint8ClampedArray;
}

/** Decodes HEIC/HEIF bytes into RGBA pixels via libheif WASM. */
export async function decodeHeic(bytes: Uint8Array): Promise<DecodedHeic> {
	const { width, height, data } = await decode({ buffer: Buffer.from(bytes) });
	if (!width || !height) {
		throw new Error('media: HEIC decode produced no dimensions');
	}
	return { width, height, data };
}

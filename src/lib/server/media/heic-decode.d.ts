/**
 * Ambient types for `heic-decode` (untyped CommonJS package; vendor has not
 * shipped declarations). Only the surface this project uses is declared —
 * see src/lib/server/media/heic.ts.
 */
declare module 'heic-decode' {
	export interface DecodeOptions {
		buffer: Uint8Array;
	}

	export interface DecodedHeicImage {
		width: number;
		height: number;
		/** RGBA pixels. */
		data: Uint8ClampedArray;
	}

	export default function decode(options: DecodeOptions): Promise<DecodedHeicImage>;
}

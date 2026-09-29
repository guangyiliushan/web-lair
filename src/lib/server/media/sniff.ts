import { isHeic, isoMediaBrand } from './heic';

/** Upload policy (plan §4.2): single file ≤ 25MB, at most 10 per batch. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_BATCH_COUNT = 10;

export type UploadKind = 'image' | 'file';

export interface SniffedUpload {
	kind: UploadKind;
	/** Canonical lowercase extension carried into the object key. */
	ext: string;
	mimeType: string;
}

interface Family {
	kind: UploadKind;
	/** Extensions that may carry this family (lowercase, no dot). */
	exts: string[];
	magic: (bytes: Uint8Array) => boolean;
	/** MIME for a given extension; defaults to a single type per family. */
	mimeFor?: Record<string, string>;
	mimeType?: string;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
	if (bytes.byteLength < at + text.length) return false;
	for (let i = 0; i < text.length; i += 1) {
		if (bytes[at + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	if (bytes.byteLength < prefix.length) return false;
	return prefix.every((byte, i) => bytes[i] === byte);
}

/** Text types carry no magic: accept when the head is free of NUL bytes. */
function looksLikeText(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 4096);
	for (const byte of head) {
		if (byte === 0) return false;
	}
	return true;
}

/**
 * Whitelist (plan §4.2). Order matters: magic-bearing families first, the
 * extension-less text family last so binary content can never slip in as
 * "text". `heic`/`heif` share the WASM decode path (plan §4.3).
 */
const FAMILIES: Family[] = [
	{
		kind: 'image',
		exts: ['jpg', 'jpeg'],
		mimeType: 'image/jpeg',
		magic: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])
	},
	{
		kind: 'image',
		exts: ['png'],
		mimeType: 'image/png',
		magic: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	},
	{
		kind: 'image',
		exts: ['gif'],
		mimeType: 'image/gif',
		magic: (bytes) => ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')
	},
	{
		kind: 'image',
		exts: ['webp'],
		mimeType: 'image/webp',
		magic: (bytes) => ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')
	},
	{
		kind: 'image',
		exts: ['avif'],
		mimeType: 'image/avif',
		magic: (bytes) => {
			const brand = isoMediaBrand(bytes);
			return brand === 'avif' || brand === 'avis';
		}
	},
	{
		kind: 'image',
		exts: ['heic', 'heif'],
		mimeType: 'image/heic',
		magic: isHeic
	},
	{
		kind: 'file',
		exts: ['pdf'],
		mimeType: 'application/pdf',
		magic: (bytes) => ascii(bytes, 0, '%PDF-')
	},
	{
		kind: 'file',
		exts: ['zip'],
		mimeType: 'application/zip',
		magic: (bytes) =>
			ascii(bytes, 0, 'PK') &&
			((bytes[2] === 3 && bytes[3] === 4) ||
				(bytes[2] === 5 && bytes[3] === 6) ||
				(bytes[2] === 7 && bytes[3] === 8))
	},
	{
		kind: 'file',
		exts: ['txt', 'md'],
		mimeFor: { txt: 'text/plain', md: 'text/markdown' },
		magic: looksLikeText
	}
];

function extensionOf(fileName: string): string | null {
	const leaf = fileName.split(/[\\/]/).pop() ?? '';
	const dot = leaf.lastIndexOf('.');
	if (dot <= 0 || dot === leaf.length - 1) return null;
	const ext = leaf.slice(dot + 1).toLowerCase();
	return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
}

/**
 * Validates an upload against the whitelist: the extension must be allowed
 * AND the content magic must match the same family (extension alone or magic
 * alone is never enough). Returns null when the upload is not acceptable.
 */
export function sniffUpload(fileName: string, bytes: Uint8Array): SniffedUpload | null {
	if (bytes.byteLength === 0) return null;
	const ext = extensionOf(fileName);
	if (!ext) return null;
	for (const family of FAMILIES) {
		if (!family.magic(bytes)) continue;
		if (!family.exts.includes(ext)) return null;
		const mimeType = family.mimeFor?.[ext] ?? family.mimeType;
		if (!mimeType) return null;
		return { kind: family.kind, ext, mimeType };
	}
	return null;
}

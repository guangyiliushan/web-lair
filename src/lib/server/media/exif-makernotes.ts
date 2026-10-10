import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExifTool } from 'exiftool-vendored';

/**
 * Brand maker-note extraction (multi-brand batch, rulings 2026-10-10):
 * every brand's family-1 group from the bundled ExifTool lands in
 * `exif.makerNotes.<brand>` — ONE decoder stack (fuji-recipes retired; its
 * 15 recipe fields are a strict subset of the FujiFilm group's 65 keys,
 * verified against the live sample). Groups that are not maker notes
 * (system, standard EXIF/MPF containers, ICC/Photoshop/JFIF, container
 * metadata) are excluded; unknown brand groups are kept (data asset, audit
 * registered). Values stay ExifTool''s PrintConv (human-readable) form;
 * numeric `-n` sidecars are registered for future filter axes.
 *
 * Security posture (§3.3): the ExifTool process only ever receives a temp
 * file with an OURS-OWNED safe name — user-controlled names never reach
 * argv (argument-injection face closed by construction; the official
 * ''-''-prefix and newline guidance is satisfied structurally). readArgs
 * are constants, never user strings.
 */

export const MAKER_NOTES_SIZE_LIMIT = 256 * 1024;

/** Groups that are not brand maker notes (excluded from the dump). */
const EXCLUDED_GROUPS = new Set([
	// system
	'SourceFile',
	'errors',
	'warnings',
	'ExifTool',
	'System',
	'File',
	// standard metadata containers
	'IFD0',
	'IFD1',
	'ExifIFD',
	'GPS',
	'InteropIFD',
	'Composite',
	'MWG',
	// non-maker blocks that share file space (FlashPix/FotoStation ride in
	// some Fuji/FotoStation files and are legacy containers, not brands —
	// caught by the live sample probe)
	'ICC_Profile',
	'ICC-header',
	'Photoshop',
	'JFIF',
	'PrintIM',
	'FlashPix',
	'FotoStation',
	// container-specific metadata groups (video / HEIC keys)
	'QuickTime',
	'Keys',
	'Meta',
	'UserData',
	'ItemList',
	'XML'
]);

/** Brand-key aliases (lowercased group → storage key). */
const BRAND_ALIASES: Record<string, string> = { fujifilm: 'fuji' };

/** Standard XMP namespaces share this prefix and are not maker notes. */
const STANDARD_PREFIXES = ['XMP'];

const GLOBAL_KEY = Symbol.for('web-lair.exiftool');

function getExifTool(): ExifTool {
	const holder = globalThis as unknown as Record<symbol, ExifTool | undefined>;
	let instance = holder[GLOBAL_KEY];
	if (!instance) {
		// One long-lived instance (docs: instances are expensive; the first
		// spawn can take seconds on Windows — keep it alive for the process).
		instance = new ExifTool({ taskTimeoutMillis: 30_000 });
		holder[GLOBAL_KEY] = instance;
	}
	return instance;
}

const EXT_BY_MIME: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/gif': 'gif',
	'image/tiff': 'tif'
};

/** Safe temp-file extension for a sniffed mime type (never a user name). */
export function tempExtForMime(mimeType: string): string {
	return EXT_BY_MIME[mimeType] ?? 'bin';
}

function sanitizeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sanitizeValue).filter((entry) => entry !== undefined);
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		// exiftool-vendored BinaryField placeholders (defense in depth; `--b`
		// already suppresses binary tags at the source).
		if (typeof record.rawValue === 'string' && typeof record.bytes === 'number') {
			return undefined;
		}
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record)) {
			const safe = sanitizeValue(entry);
			if (safe !== undefined) out[key] = safe;
		}
		return out;
	}
	return undefined;
}

function capAndTrim(brands: Record<string, Record<string, unknown>>): Record<string, unknown> {
	const encoded = JSON.stringify(brands);
	if (encoded.length <= MAKER_NOTES_SIZE_LIMIT) return brands;
	// Deterministic trim: drop the largest tags first until the payload fits,
	// and leave a VISIBLE marker (silent truncation is never acceptable).
	let total = encoded.length;
	const entries: Array<{ brand: string; tag: string; size: number }> = [];
	for (const [brand, tags] of Object.entries(brands)) {
		for (const [tag, value] of Object.entries(tags)) {
			entries.push({ brand, tag, size: JSON.stringify(value).length + tag.length });
		}
	}
	entries.sort((a, b) => b.size - a.size);
	let dropped = 0;
	for (const entry of entries) {
		if (total <= MAKER_NOTES_SIZE_LIMIT) break;
		delete brands[entry.brand]![entry.tag];
		total -= entry.size;
		dropped += 1;
	}
	return {
		...brands,
		_truncated: {
			droppedTags: dropped,
			originalChars: encoded.length,
			limitChars: MAKER_NOTES_SIZE_LIMIT
		}
	};
}

/** Pure: group a `-G1` tag map into the storage shape (unit-tested). */
export function groupBrandDump(tags: Record<string, unknown>): Record<string, unknown> {
	const brands: Record<string, Record<string, unknown>> = {};
	for (const [qualifiedKey, rawValue] of Object.entries(tags)) {
		const colon = qualifiedKey.indexOf(':');
		if (colon <= 0) continue;
		const group = qualifiedKey.slice(0, colon);
		if (EXCLUDED_GROUPS.has(group)) continue;
		if (STANDARD_PREFIXES.some((prefix) => group === prefix || group.startsWith(`${prefix}-`))) {
			continue;
		}
		const tag = qualifiedKey.slice(colon + 1);
		const brandKey = BRAND_ALIASES[group.toLowerCase()] ?? group.toLowerCase();
		const safe = sanitizeValue(rawValue);
		if (safe === undefined) continue;
		(brands[brandKey] ??= {})[tag] = safe;
	}
	return capAndTrim(brands);
}

/**
 * Extract the brand maker-note dump for an upload''s bytes. Returns null on
 * any failure — parse problems never block an ingest. Callers merge the
 * result into `exif` via {@link mergeMakerNotes}.
 */
export async function extractMakerNotes(
	bytes: Uint8Array,
	options: { ext: string }
): Promise<Record<string, unknown> | null> {
	let dir: string | null = null;
	try {
		dir = await mkdtemp(join(tmpdir(), 'wl-exif-'));
		const file = join(dir, `probe-${randomUUID()}.${options.ext}`);
		await writeFile(file, bytes);
		const tags = (await getExifTool().read(file, {
			readArgs: ['-G1', '--b']
		})) as unknown as Record<string, unknown>;
		const grouped = groupBrandDump(tags);
		return Object.keys(grouped).length > 0 ? grouped : null;
	} catch (cause) {
		// Observability: one structured line, never the raw driver payload.
		console.warn('exif-makernotes: extraction failed', {
			error: cause instanceof Error ? cause.name : 'unknown'
		});
		return null;
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Merge the brand dump into the stored exif payload under `makerNotes`. */
export function mergeMakerNotes(
	exif: Record<string, unknown> | null,
	makerNotes: Record<string, unknown> | null
): Record<string, unknown> | null {
	if (!makerNotes || Object.keys(makerNotes).length === 0) return exif;
	return { ...(exif ?? {}), makerNotes };
}

import { Buffer } from 'node:buffer';
import exifr from '@laosb/exifr';
import getFujiRecipe from 'fuji-recipes';

/**
 * Photo EXIF extraction (storage line §3.3 / §4.3): `@laosb/exifr` for the
 * general parse plus `fuji-recipes` for the Fujifilm MakerNote recipe block.
 * Pure and storage-agnostic — the caller hands in the original bytes and the
 * site timezone (`site.timezone` option), keeping this module unit-testable.
 */

export interface PhotoExif {
	takenAt: Date | null;
	cameraMake: string | null;
	cameraModel: string | null;
	lensModel: string | null;
	fNumber: number | null;
	focalLengthMm: number | null;
	exposureTimeS: number | null;
	iso: number | null;
	latitude: number | null;
	longitude: number | null;
	altitudeM: number | null;
	/** JSON-safe full parse (Fuji recipe folded in; binary blobs dropped). */
	exif: Record<string, unknown> | null;
}

type ParsedExif = Record<string, unknown>;

/** Keys dropped from the stored jsonb (binary payloads / already folded in). */
const DROP_KEYS = new Set(['makerNote', 'thumbnail', 'icc']);

/** "±HH:MM" / "±HHMM" → "±HH:MM"; anything else → null. */
export function normalizeOffset(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
	if (!match) return null;
	return `${match[1]}${match[2]}:${match[3]}`;
}

/**
 * "YYYY-MM-DDTHH:MM:SS" from a Date's LOCAL components — exifr revives the
 * naive EXIF wall-clock through the server's local zone, so the local getters
 * reproduce the original naive value.
 */
export function naiveOfLocal(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Interpret a naive wall clock in an IANA zone and return the UTC instant.
 * One Intl-based correction pass is exact for fixed offsets; a DST seam at
 * the exact capture second may be off by the shift — acceptable for a
 * capture timestamp. Invalid zones fall back to UTC.
 */
export function zonedNaiveToUtc(naive: string, timeZone: string): Date | null {
	const guess = new Date(`${naive}Z`);
	if (Number.isNaN(guess.getTime())) return null;
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		const parts: Record<string, number> = {};
		for (const part of formatter.formatToParts(guess)) {
			if (part.type !== 'literal') parts[part.type] = Number(part.value);
		}
		const asUtc = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour % 24,
			parts.minute,
			parts.second
		);
		return new Date(guess.getTime() - (asUtc - guess.getTime()));
	} catch {
		return guess; // unknown zone → treat the wall clock as UTC
	}
}

/** EXIF date ("YYYY:MM:DD HH:MM:SS") + optional offset → UTC instant. */
export function composeTakenAt(
	dateTimeOriginal: unknown,
	offset: unknown,
	timeZone: string
): Date | null {
	let naive: string | null = null;
	if (dateTimeOriginal instanceof Date) {
		naive = naiveOfLocal(dateTimeOriginal);
	} else if (typeof dateTimeOriginal === 'string') {
		const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
			dateTimeOriginal.trim()
		);
		if (match) naive = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
	}
	if (!naive) return null;
	const normalized = normalizeOffset(offset);
	if (normalized) {
		const withOffset = new Date(`${naive}${normalized}`);
		return Number.isNaN(withOffset.getTime()) ? null : withOffset;
	}
	return zonedNaiveToUtc(naive, timeZone);
}

/**
 * Deep-copy into JSON-safe values; binary views (maker note bytes, ICC) drop
 * out and NUL (U+0000) is stripped from strings — PostgreSQL jsonb cannot
 * carry U+0000 at all (`unsupported Unicode escape sequence`), and real
 * Fujifilm files ship NUL-padded fields (e.g. Copyright), caught by the T13
 * live import.
 */
export function toJsonSafe(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return null;
	if (depth > 6) return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string') {
		return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
	}
	if (typeof value === 'boolean') return value;
	if (ArrayBuffer.isView(value)) return undefined;
	if (Array.isArray(value)) {
		return value
			.map((entry) => toJsonSafe(entry, depth + 1))
			.filter((entry) => entry !== undefined);
	}
	if (typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (DROP_KEYS.has(key)) continue;
			const safe = toJsonSafe(entry, depth + 1);
			if (safe !== undefined) result[key] = safe;
		}
		return result;
	}
	return undefined;
}

const ZONED_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = ZONED_FORMATTER_CACHE.get(timeZone);
	if (cached) return cached;
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});
	ZONED_FORMATTER_CACHE.set(timeZone, formatter);
	return formatter;
}

/** Format an instant as the naive wall clock in an IANA zone ("YYYY-MM-DDTHH:MM"). */
export function zonedNaiveOf(date: Date, timeZone: string): string {
	try {
		const parts: Record<string, string> = {};
		for (const part of zonedFormatter(timeZone).formatToParts(date)) {
			if (part.type !== 'literal') parts[part.type] = part.value;
		}
		return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
	} catch {
		return date.toISOString().slice(0, 16);
	}
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const rational = /^(\d+)\/(\d+)$/.exec(value.trim());
		if (rational && Number(rational[2]) !== 0) return Number(rational[1]) / Number(rational[2]);
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : null;
	}
	return null;
}

function asString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	// Same PG boundary as `toJsonSafe`: text columns cannot carry U+0000.
	const cleaned = value.replaceAll('\u0000', '').trim();
	return cleaned !== '' ? cleaned : null;
}

const EMPTY: PhotoExif = {
	takenAt: null,
	cameraMake: null,
	cameraModel: null,
	lensModel: null,
	fNumber: null,
	focalLengthMm: null,
	exposureTimeS: null,
	iso: null,
	latitude: null,
	longitude: null,
	altitudeM: null,
	exif: null
};

export interface ExtractOptions {
	/** IANA zone used when the file carries no UTC offset (site.timezone). */
	timeZone?: string;
}

export async function extractPhotoMetadata(
	bytes: Uint8Array,
	options: ExtractOptions = {}
): Promise<PhotoExif> {
	let parsed: ParsedExif | null = null;
	try {
		const result = (await exifr.parse(bytes, { makerNote: true })) as ParsedExif | undefined;
		if (result && typeof result === 'object') parsed = result;
	} catch {
		return { ...EMPTY };
	}
	if (!parsed) return { ...EMPTY };

	let fujiRecipe: unknown = undefined;
	const makerNote = parsed.makerNote;
	if (makerNote !== undefined && makerNote !== null) {
		try {
			const input = ArrayBuffer.isView(makerNote)
				? Buffer.from(makerNote.buffer, makerNote.byteOffset, makerNote.byteLength)
				: Array.isArray(makerNote)
					? (makerNote as number[])
					: null;
			if (input) {
				const recipe = getFujiRecipe(input);
				if (recipe) fujiRecipe = recipe;
			}
		} catch {
			// Maker note is best-effort; the general parse stands on its own.
		}
	}

	const safe = (toJsonSafe(parsed) as Record<string, unknown> | undefined) ?? {};
	if (fujiRecipe !== undefined) safe.fujiRecipe = fujiRecipe;

	return {
		takenAt: composeTakenAt(
			parsed.DateTimeOriginal,
			parsed.OffsetTimeOriginal ?? parsed.OffsetTime,
			options.timeZone ?? 'UTC'
		),
		cameraMake: asString(parsed.Make),
		cameraModel: asString(parsed.Model),
		lensModel: asString(parsed.LensModel),
		fNumber: asNumber(parsed.FNumber),
		focalLengthMm: asNumber(parsed.FocalLength),
		exposureTimeS: asNumber(parsed.ExposureTime),
		iso: asNumber(parsed.ISO),
		latitude: asNumber(parsed.latitude),
		longitude: asNumber(parsed.longitude),
		altitudeM: asNumber(parsed.GPSAltitude),
		exif: Object.keys(safe).length > 0 ? safe : null
	};
}

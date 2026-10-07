/**
 * Small mapping helpers shared by the four adapters (plan §3.2): raw API
 * payloads are untrusted - every field is narrowed here so a platform-side
 * shape change surfaces as a `parse` failure instead of silent nulls.
 */
import { ProjectsFetchError } from '../fetch.ts';

export function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new ProjectsFetchError('parse', `${what} is not an object`);
	}
	return value as Record<string, unknown>;
}

export function asArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new ProjectsFetchError('parse', `${what} is not an array`);
	return value;
}

export function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** ISO timestamp -> Date; unparsable values become null (lenient snapshot). */
export function dateOrNull(value: unknown): Date | null {
	if (typeof value !== 'string') return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Platform-stable id unified as string; missing id is a parse failure. */
export function requiredId(value: unknown, what: string): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'string' && value.length > 0) return value;
	throw new ProjectsFetchError('parse', `${what} has no usable id`);
}

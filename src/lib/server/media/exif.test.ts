import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	composeTakenAt,
	extractPhotoMetadata,
	normalizeOffset,
	toJsonSafe,
	zonedNaiveOf,
	zonedNaiveToUtc
} from './exif';

describe('normalizeOffset', () => {
	it('accepts ±HH:MM and ±HHMM', () => {
		expect(normalizeOffset('+09:00')).toBe('+09:00');
		expect(normalizeOffset('-0530')).toBe('-05:30');
	});
	it('rejects anything else', () => {
		expect(normalizeOffset('x')).toBeNull();
		expect(normalizeOffset(null)).toBeNull();
		expect(normalizeOffset('+9:00')).toBeNull();
	});
});

describe('zonedNaiveToUtc', () => {
	it('interprets a wall clock in a fixed-offset zone', () => {
		expect(zonedNaiveToUtc('2026-01-02T12:00:00', 'Asia/Taipei')?.toISOString()).toBe(
			'2026-01-02T04:00:00.000Z'
		);
	});
	it('treats UTC as identity', () => {
		expect(zonedNaiveToUtc('2026-01-02T12:00:00', 'UTC')?.toISOString()).toBe(
			'2026-01-02T12:00:00.000Z'
		);
	});
	it('falls back to UTC for unknown zones and invalid input', () => {
		expect(zonedNaiveToUtc('2026-01-02T12:00:00', 'Not/AZone')?.toISOString()).toBe(
			'2026-01-02T12:00:00.000Z'
		);
		expect(zonedNaiveToUtc('garbage', 'UTC')).toBeNull();
	});
});

describe('zonedNaiveOf', () => {
	it('formats an instant as the wall clock in the zone', () => {
		expect(zonedNaiveOf(new Date('2026-01-02T04:00:00Z'), 'Asia/Taipei')).toBe('2026-01-02T12:00');
		expect(zonedNaiveOf(new Date('2026-01-02T04:00:00Z'), 'Not/AZone')).toBe('2026-01-02T04:00');
	});
});

describe('composeTakenAt', () => {
	it('prefers an explicit EXIF offset', () => {
		const taken = composeTakenAt('2026:01:02 12:00:00', '+09:00', 'UTC');
		expect(taken?.toISOString()).toBe('2026-01-02T03:00:00.000Z');
	});
	it('falls back to the site zone without an offset', () => {
		const taken = composeTakenAt('2026:01:02 12:00:00', undefined, 'Asia/Taipei');
		expect(taken?.toISOString()).toBe('2026-01-02T04:00:00.000Z');
	});
	it('returns null when the date is missing', () => {
		expect(composeTakenAt(undefined, '+09:00', 'UTC')).toBeNull();
	});
});

describe('toJsonSafe', () => {
	it('revives dates and drops binary views', () => {
		const safe = toJsonSafe({
			when: new Date('2026-01-01T00:00:00Z'),
			bytes: new Uint8Array([1, 2]),
			list: [1, new Uint8Array([3]), 'x'],
			nested: { infinity: Number.POSITIVE_INFINITY }
		});
		expect(safe).toEqual({
			when: '2026-01-01T00:00:00.000Z',
			list: [1, 'x'],
			nested: { infinity: null }
		});
	});
});

describe('extractPhotoMetadata', () => {
	it('survives input without EXIF', async () => {
		const result = await extractPhotoMetadata(Uint8Array.from([0, 1, 2, 3]));
		expect(result).toMatchObject({ takenAt: null, exif: null, cameraMake: null });
	});

	it('parses the HEIC fixture without throwing', async () => {
		const bytes = new Uint8Array(readFileSync(new URL('./fixtures/example.heic', import.meta.url)));
		const result = await extractPhotoMetadata(bytes, { timeZone: 'UTC' });
		expect(result.takenAt === null || result.takenAt instanceof Date).toBe(true);
		expect(result.cameraMake === null || typeof result.cameraMake === 'string').toBe(true);
		expect(result.exif === null || typeof result.exif === 'object').toBe(true);
	});
});

describe('toJsonSafe — PostgreSQL jsonb boundaries', () => {
	it('strips NUL (U+0000): jsonb cannot carry it (T13 live import)', () => {
		expect(toJsonSafe({ copyright: '\u0000', mixed: 'a\u0000b' })).toEqual({
			copyright: '',
			mixed: 'ab'
		});
	});

	it('keeps ordinary control characters intact', () => {
		expect(toJsonSafe({ tab: 'a\tb' })).toEqual({ tab: 'a\tb' });
	});
});

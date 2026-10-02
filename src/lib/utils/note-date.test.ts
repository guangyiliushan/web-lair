import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => 'en' }));

import { noteDateLabel, noteDisplayTimeZone } from './note-date';

describe('note date helpers', () => {
	it('falls back to the site zone for null or invalid note tz (no throw)', () => {
		expect(noteDisplayTimeZone(null, 'UTC')).toBe('UTC');
		expect(noteDisplayTimeZone(undefined, 'UTC')).toBe('UTC');
		expect(noteDisplayTimeZone('Asia/Tokyo', 'UTC')).toBe('Asia/Tokyo');
		expect(noteDisplayTimeZone('Not/AZone', 'UTC')).toBe('UTC');
	});

	it('formats in the resolved zone (cross-midnight visible)', () => {
		const at = new Date('2026-10-01T20:00:00Z');
		expect(noteDateLabel(at, 'Asia/Tokyo', 'UTC')).toBe('October 2, 2026');
		expect(noteDateLabel(at, null, 'UTC')).toBe('October 1, 2026');
		expect(noteDateLabel(at, 'Not/AZone', 'UTC')).toBe('October 1, 2026');
	});

	it('shifts the belongs-to day across a year boundary', () => {
		const at = new Date('2025-12-31T20:00:00Z');
		expect(noteDateLabel(at, 'Asia/Tokyo', 'UTC')).toBe('January 1, 2026');
		expect(noteDateLabel(at, null, 'UTC')).toBe('December 31, 2025');
	});
});

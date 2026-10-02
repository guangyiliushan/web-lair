import { describe, expect, it } from 'vitest';
import { notesFilterHref } from './note-links';

describe('notesFilterHref', () => {
	it('preserves the other filter dimension and encodes the topic', () => {
		expect(notesFilterHref({ topic: 'a b"c', year: null }, { year: 2026 })).toBe(
			'/notes?topic=a%20b%22c&year=2026'
		);
		expect(notesFilterHref({ topic: 'travel', year: 2026 }, { topic: null })).toBe(
			'/notes?year=2026'
		);
		expect(notesFilterHref({ topic: 'travel', year: 2026 }, { year: null })).toBe(
			'/notes?topic=travel'
		);
	});

	it('builds bare pages and pagination links without stale filters', () => {
		expect(notesFilterHref({ topic: null, year: null }, {})).toBe('/notes');
		expect(notesFilterHref({ topic: 't', year: 2 }, { page: 3 })).toBe(
			'/notes?topic=t&year=2&page=3'
		);
		expect(notesFilterHref({ topic: 't', year: 2 }, { page: 1 })).toBe('/notes?topic=t&year=2');
	});
});

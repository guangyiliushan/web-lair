import { describe, expect, it } from 'vitest';
import { ifModifiedSinceCovers, ifNoneMatchMatches } from './cache';

describe('ifNoneMatchMatches', () => {
	const etag = '"abc123"';

	it('matches exact, star and comma-separated lists (weak comparison)', () => {
		expect(ifNoneMatchMatches(etag, etag)).toBe(true);
		expect(ifNoneMatchMatches('*', etag)).toBe(true);
		expect(ifNoneMatchMatches('"other", "abc123"', etag)).toBe(true);
		expect(ifNoneMatchMatches('W/"abc123"', etag)).toBe(true);
		expect(ifNoneMatchMatches('  "abc123"  ', etag)).toBe(true);
	});

	it('does not match different or missing validators', () => {
		expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
		expect(ifNoneMatchMatches(null, etag)).toBe(false);
		expect(ifNoneMatchMatches('', etag)).toBe(false);
	});
});

describe('ifModifiedSinceCovers', () => {
	const latest = new Date('2026-09-30T09:00:00Z');

	it('covers second-granularity equal-or-later instants', () => {
		expect(ifModifiedSinceCovers('Wed, 30 Sep 2026 09:00:00 GMT', latest)).toBe(true);
		expect(ifModifiedSinceCovers('Wed, 30 Sep 2026 09:00:01 GMT', latest)).toBe(true);
	});

	it('rejects earlier instants, junk and missing values', () => {
		expect(ifModifiedSinceCovers('Wed, 30 Sep 2026 08:59:59 GMT', latest)).toBe(false);
		expect(ifModifiedSinceCovers('not a date', latest)).toBe(false);
		expect(ifModifiedSinceCovers(null, latest)).toBe(false);
		expect(ifModifiedSinceCovers('Wed, 30 Sep 2026 09:00:00 GMT', null)).toBe(false);
	});
});

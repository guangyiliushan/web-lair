import { describe, expect, it } from 'vitest';
import { locales } from '$lib/paraglide/runtime';
import { isReservedPageSlug, PAGE_RESERVED_SLUGS } from './page-meta';

/**
 * The reserved list is also the shadow defense for the bare-language roots
 * (P1b review): every configured locale tag must stay reserved so a page slug
 * can never take over `/en`-style paths. The [slug] route carries a second
 * read-side guard for rows that predate the entry.
 */
describe('page reserved slugs', () => {
	it('reserves every configured locale tag', () => {
		for (const tag of locales) {
			expect(PAGE_RESERVED_SLUGS.has(tag), tag).toBe(true);
		}
	});

	it('flags the seeds and system segments, not arbitrary slugs', () => {
		expect(isReservedPageSlug('about')).toBe(true);
		expect(isReservedPageSlug('admin')).toBe(true);
		expect(isReservedPageSlug('sponsor')).toBe(false);
	});
});

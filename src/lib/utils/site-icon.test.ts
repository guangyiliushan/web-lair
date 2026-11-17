import { describe, expect, it } from 'vitest';
import { siteIconHref } from './site-icon';

const FALLBACK = '/_app/immutable/assets/favicon.hash.svg';

describe('siteIconHref', () => {
	it('falls back to the bundled asset when the icon is unset or empty', () => {
		expect(siteIconHref(null, FALLBACK)).toBe(FALLBACK);
		expect(siteIconHref(undefined, FALLBACK)).toBe(FALLBACK);
		expect(siteIconHref({ url: '   ', version: 3 }, FALLBACK)).toBe(FALLBACK);
	});

	it('appends the version cache bust to an https icon', () => {
		expect(siteIconHref({ url: 'https://cdn.example/favicon.svg', version: 7 }, FALLBACK)).toBe(
			'https://cdn.example/favicon.svg?v=7'
		);
		// A URL that already carries a query string gets `&v=` instead.
		expect(
			siteIconHref({ url: 'https://cdn.example/icon.svg?size=32', version: 8 }, FALLBACK)
		).toBe('https://cdn.example/icon.svg?size=32&v=8');
	});

	it('accepts the same-origin /i/ proxy', () => {
		expect(siteIconHref({ url: '/i/favicon.ico', version: 1 }, FALLBACK)).toBe(
			'/i/favicon.ico?v=1'
		);
	});

	it('places the cache bust before a fragment instead of inside it', () => {
		expect(siteIconHref({ url: 'https://cdn.example/icon.svg#dark', version: 2 }, FALLBACK)).toBe(
			'https://cdn.example/icon.svg?v=2#dark'
		);
		expect(siteIconHref({ url: '/i/icon.svg#dark', version: 3 }, FALLBACK)).toBe(
			'/i/icon.svg?v=3#dark'
		);
	});

	it('falls back for schemes the registry never stores', () => {
		for (const url of ['http://example.com/a.ico', 'javascript:alert(1)', 'data:,x', 'i/a.ico']) {
			expect(siteIconHref({ url, version: 1 }, FALLBACK)).toBe(FALLBACK);
		}
	});

	it('treats a non-integer version as 0 instead of emitting NaN', () => {
		expect(siteIconHref({ url: 'https://x/a.svg', version: Number.NaN }, FALLBACK)).toBe(
			'https://x/a.svg?v=0'
		);
	});
});

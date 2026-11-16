import { describe, expect, it } from 'vitest';
import { reroute } from './hooks';

/**
 * Pins the `reroute` hook: de-localizing prefixed paths is what keeps the root
 * distribution endpoints answering under `/{lang}/…` (200 aliases). Removing it
 * silently 404s every prefixed feed.
 */
describe('reroute (locale-prefixed paths resolve to neutral routes)', () => {
	it('de-localises feed and file paths so the root endpoints answer', () => {
		expect(reroute({ url: new URL('http://x/en/rss.xml') } as never)).toBe('/rss.xml');
		expect(reroute({ url: new URL('http://x/ja/sitemap.xml') } as never)).toBe('/sitemap.xml');
		expect(reroute({ url: new URL('http://x/zh-cn/robots.txt') } as never)).toBe('/robots.txt');
	});

	it('keeps neutral and locale-free paths stable', () => {
		expect(reroute({ url: new URL('http://x/rss.xml') } as never)).toBe('/rss.xml');
		expect(reroute({ url: new URL('http://x/account') } as never)).toBe('/account');
	});
});

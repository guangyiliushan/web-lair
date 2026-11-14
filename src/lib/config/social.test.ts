import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: () => () => 'label' })
}));

import {
	SOCIAL_RAIL_FIXED,
	isExternalSocialHref,
	isSafeSocialHref,
	socialHostMatches,
	socialRailItems
} from './social';

describe('social presets', () => {
	it('matches the preset host and its subdomains only', () => {
		expect(socialHostMatches('github.com', ['github.com'])).toBe(true);
		expect(socialHostMatches('gist.github.com', ['github.com'])).toBe(true);
		expect(socialHostMatches('notgithub.com', ['github.com'])).toBe(false);
		expect(socialHostMatches('github.com.evil.test', ['github.com'])).toBe(false);
	});

	it('accepts https preset hosts and mailto email only', () => {
		expect(isSafeSocialHref('github', 'https://github.com/guang')).toBe(true);
		expect(isSafeSocialHref('x', 'https://twitter.com/guang')).toBe(true);
		expect(isSafeSocialHref('email', 'mailto:me@example.com')).toBe(true);
		expect(isSafeSocialHref('email', 'https://example.com')).toBe(false);
		expect(isSafeSocialHref('github', 'http://github.com/guang')).toBe(false);
		expect(isSafeSocialHref('github', 'javascript:alert(1)')).toBe(false);
		expect(isSafeSocialHref('github', 'https://example.com/guang')).toBe(false);
	});

	it('marks only https links as external (mailto and /rss.xml stay internal)', () => {
		expect(isExternalSocialHref('https://github.com/guang')).toBe(true);
		expect(isExternalSocialHref('mailto:me@example.com')).toBe(false);
		expect(isExternalSocialHref('/rss.xml')).toBe(false);
	});

	it('keeps user order, appends the fixed RSS item exactly once', () => {
		const items = socialRailItems([
			{ platform: 'github', href: 'https://github.com/guang' },
			{ platform: 'email', href: 'mailto:me@example.com' }
		]);

		expect(items.map((item) => item.platform)).toEqual(['github', 'email', 'rss']);
		expect(items.filter((item) => item.platform === 'rss')).toHaveLength(1);
		expect(items.at(-1)?.href).toBe(SOCIAL_RAIL_FIXED[0].href);
	});

	it('skips unknown platforms and unsafe rows instead of rendering them', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const items = socialRailItems([
			{ platform: 'mastodon', href: 'https://example.com/@me' },
			{ platform: 'github', href: 'javascript:alert(1)' },
			{ platform: 'github', href: 'https://github.com/guang' }
		]);

		expect(items.map((item) => item.platform)).toEqual(['github', 'rss']);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it('always renders the RSS entry even with no user links', () => {
		expect(socialRailItems(null).map((item) => item.platform)).toEqual(['rss']);
		expect(socialRailItems([]).map((item) => item.platform)).toEqual(['rss']);
	});
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { mergeHomeMenuItems } from './navigation.config';

/**
 * T4 (P1b) render-order fixture: the home menu shows dynamic pages first
 * (defaults → extras, straight from the chrome loader) and keeps the four
 * original quick links as a trailing group.
 */
describe('mergeHomeMenuItems (P1b home-card order)', () => {
	it('prepends dynamic pages (defaults → extras) before the static quick links', () => {
		const dynamic = [
			{ label: 'About Me', href: '/about' },
			{ label: 'About This Project', href: '/about-site' },
			{ label: 'Sponsor', href: 'https://example.com' }
		];
		const fixed = [
			{ labelKey: 'nav_home_rss' as const, href: '/rss.xml' },
			{ labelKey: 'nav_home_github' as const, href: 'https://github.com/x' },
			{ labelKey: 'nav_home_twitter' as const, href: 'https://twitter.com/x' },
			{ labelKey: 'nav_home_email' as const, href: 'mailto:x@example.com' }
		];

		expect(mergeHomeMenuItems(dynamic, fixed).map((item) => item.href)).toEqual([
			'/about',
			'/about-site',
			'https://example.com',
			'/rss.xml',
			'https://github.com/x',
			'https://twitter.com/x',
			'mailto:x@example.com'
		]);
	});

	it('keeps the static quick links alone when no dynamic pages exist', () => {
		const fixed = [{ href: '/rss.xml' }];
		expect(mergeHomeMenuItems(null, fixed)).toEqual(fixed);
		expect(mergeHomeMenuItems(undefined, fixed)).toEqual(fixed);
		expect(mergeHomeMenuItems([], fixed)).toEqual(fixed);
	});

	it('preserves the incoming chrome order (never re-sorts the items)', () => {
		const dynamic = [
			{ label: 'Zeta', href: '/zeta' },
			{ label: 'Alpha', href: '/alpha' }
		];

		expect(mergeHomeMenuItems(dynamic, []).map((item) => item.href)).toEqual(['/zeta', '/alpha']);
	});
});

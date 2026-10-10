import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { mergeHomeMenuItems, navigationConfig } from './navigation.config';

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

/**
 * C2 (micro-content line): the retired 思考 slot in the top nav now carries
 * 微记, and the "more" menu hosts 摘录 / 思考 on the renamed routes; the
 * mobile `children` array mirrors the mega items.
 */
describe('micro-content navigation config (C2)', () => {
	it('retires nav_thinking and slots nav_moments before nav_more', () => {
		expect(navigationConfig.map((item) => item.key)).toEqual([
			'nav_home',
			'nav_posts',
			'nav_notes',
			'nav_timeline',
			'nav_moments',
			'nav_more'
		]);
	});

	it('wires 微记 to /moments', () => {
		const moments = navigationConfig.find((item) => item.key === 'nav_moments');
		expect(moments?.labelKey).toBe('nav_moments');
		expect(moments?.href).toBe('/moments');
	});

	it('mirrors the more menu between the mega items and the children array', () => {
		const more = navigationConfig.find((item) => item.key === 'nav_more');
		const expected = [
			'/friends',
			'/projects',
			'/photos',
			'/quotes',
			'/thoughts',
			'https://travel.moe/go.html'
		];
		const megaItems =
			more?.megaMenu?.columns.flatMap((column) => column.items).map((child) => child.href) ?? [];
		expect(megaItems).toEqual(expected);
		expect(more?.children?.map((child) => child.href) ?? []).toEqual(expected);
	});

	it('leaves no legacy micro-content paths in the static config', () => {
		const hrefs: string[] = [];
		for (const item of navigationConfig) {
			hrefs.push(item.href);
			for (const child of item.children ?? []) hrefs.push(child.href);
			for (const column of item.megaMenu?.columns ?? []) {
				for (const child of column.items) hrefs.push(child.href);
			}
		}
		expect(hrefs).not.toContain('/says');
		expect(hrefs).not.toContain('/thinking');
	});
});

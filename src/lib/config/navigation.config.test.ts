import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { navigationConfig } from './navigation.config';

/**
 * The retired `思考` slot in the top nav now carries
 * `微记`, and the "more" menu hosts `摘录` / `思考` on the renamed routes; the
 * mobile `children` array mirrors the mega items.
 */
describe('micro-content navigation config', () => {
	it('retires nav_thinking and slots nav_moments before nav_timeline', () => {
		expect(navigationConfig.map((item) => item.key)).toEqual([
			'nav_home',
			'nav_posts',
			'nav_notes',
			'nav_moments',
			'nav_timeline',
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

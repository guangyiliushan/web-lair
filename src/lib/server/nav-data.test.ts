import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the real mega-menu data (P3-b): the posts loader maps the
 * locale's categories (curated order, visible counts) and the latest visible
 * posts into neutral hrefs; the timeline loader builds the post activity
 * stream. The db module is mocked with a queue of select results.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja']
}));

import { loadPostsMegaData, loadTimelineMegaData } from './nav-data';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (..._args: unknown[]) => self;
			}
		}
	);
	return self;
}

describe('nav-data loaders', () => {
	beforeEach(() => {
		state.selectResults = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('maps the posts mega data from real queries', async () => {
		state.selectResults = [
			[
				{ name: 'Tech', slug: 'tech', total: 3 },
				{ name: 'Life', slug: 'life', total: 1 }
			],
			[
				{ slug: 'a', title: 'Post A', publishedAt: new Date(2026, 0, 15, 12) },
				{ slug: 'b', title: 'Post B', publishedAt: null }
			],
			[{ total: 4 }]
		];

		const data = await loadPostsMegaData();

		expect(data.leftItems).toEqual([
			{ label: 'Tech', href: '/posts/categories/tech', badge: 3 },
			{ label: 'Life', href: '/posts/categories/life', badge: 1 }
		]);
		expect(data.rightItems).toEqual([
			{ label: 'Post A', href: '/posts/a', desc: 'January 15, 2026' }
		]);
		expect(data.footerSecondaryText).toBe('4 posts');
	});

	it('builds the timeline activity stream from visible posts', async () => {
		state.selectResults = [
			[{ slug: 'a', title: 'Post A', publishedAt: new Date(2026, 0, 15, 12) }]
		];

		const data = await loadTimelineMegaData();

		expect(data.timelineItems).toEqual([
			{ title: 'Post A', href: '/posts/a', type: 'posts', date: 'January 15, 2026' }
		]);
	});
});

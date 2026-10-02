import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Unit tests for the real mega-menu data (P3-b): the posts loader maps the
 * locale's categories (curated order, visible counts) and the latest visible
 * posts into neutral hrefs; the timeline loader builds the post activity
 * stream. The db module is mocked with a queue of select results.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[],
		joinArgs: [] as unknown[][]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja'],
	// The generated messages module imports this; keep it present for the
	// real nav_posts_count() call in the footer text (review finding).
	experimentalStaticLocale: undefined
}));

import { loadNotesMegaData, loadPostsMegaData, loadTimelineMegaData } from './nav-data';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (...args: unknown[]) => {
					if (prop === 'where') state.whereArgs.push(args[0]);
					if (prop === 'innerJoin') state.joinArgs.push(args);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('nav-data loaders', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.whereArgs = [];
		state.joinArgs = [];
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
			]
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

	it('builds the merged timeline stream from posts and notes', async () => {
		state.selectResults = [
			[{ slug: 'a', title: 'Post A', publishedAt: new Date(2026, 0, 15, 12) }],
			[
				{
					id: 'n1',
					slug: 'trip',
					title: 'Trip',
					publishedAt: new Date(2026, 1, 1, 12),
					tz: null,
					locked: false
				}
			]
		];

		const data = await loadTimelineMegaData();

		expect(data.timelineItems).toEqual([
			{ title: 'Trip', href: '/notes/trip', type: 'notes', date: 'February 1, 2026' },
			{ title: 'Post A', href: '/posts/a', type: 'posts', date: 'January 15, 2026' }
		]);
	});

	it('maps the notes mega data from real queries', async () => {
		state.selectResults = [
			[{ id: 't1', name: 'Travel', slug: 'travel', icon: 'plane', total: 3 }],
			[
				{
					id: 'n1',
					slug: 'trip',
					title: 'Trip',
					publishedAt: new Date(2026, 0, 15, 12),
					tz: null,
					locked: true
				}
			],
			[{ total: 7 }]
		];

		const data = await loadNotesMegaData();

		expect(data.leftItems).toEqual([
			{ label: 'Travel', href: '/notes/topics/travel', iconName: 'plane', badge: 3 }
		]);
		expect(data.rightItems).toEqual([
			{ label: 'Trip', href: '/notes/trip', desc: 'January 15, 2026', locked: true }
		]);
		expect(data.footerSecondaryText).toBe('7 notes');
	});

	it('pins the locale + visibility predicates on every mega query (review finding)', async () => {
		state.selectResults = [[], []];
		await loadPostsMegaData();

		// Categories query: the predicate sits in the posts JOIN condition.
		expect(state.joinArgs).toHaveLength(1);
		const joinSql = dialect.sqlToQuery(state.joinArgs[0]?.[1] as never).sql;
		expect(joinSql).toContain('"posts"."lang"');
		expect(joinSql).toContain('"posts"."status"');

		// Recent query: WHERE-guarded (the aggregate carries the total).
		expect(state.whereArgs).toHaveLength(1);
		for (const condition of state.whereArgs) {
			const sql = dialect.sqlToQuery(condition as never).sql;
			expect(sql).toContain('"posts"."lang"');
			expect(sql).toContain('"posts"."status"');
		}

		// Timeline loader: posts + notes summaries, each guarded.
		state.selectResults = [[], []];
		state.whereArgs = [];
		await loadTimelineMegaData();
		expect(state.whereArgs).toHaveLength(2);
		const [postWhere, noteWhere] = state.whereArgs.map(
			(condition) => dialect.sqlToQuery(condition as never).sql
		);
		expect(postWhere).toContain('"posts"."lang"');
		expect(postWhere).toContain('"posts"."status"');
		expect(noteWhere).toContain('"notes"."lang"');
		expect(noteWhere).toContain('"notes"."status"');
	});
});

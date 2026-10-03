import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Unit tests for the real mega-menu data (P3-b): the posts loader maps the
 * locale's categories (curated order, visible counts) and the latest visible
 * posts into neutral hrefs; the timeline loader builds the post activity
 * stream; the pages chrome loader (P1b) maps ordered rows with fallback
 * labels and footer defaults. The db module is mocked with a queue of
 * select results.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[],
		joinArgs: [] as unknown[][],
		limitArgs: [] as unknown[],
		orderArgs: [] as unknown[]
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
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'UTC')
}));

import {
	loadNotesMegaData,
	loadPagesMegaData,
	loadPostsMegaData,
	loadTimelineMegaData
} from './nav-data';

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
					if (prop === 'limit') state.limitArgs.push(args[0]);
					if (prop === 'orderBy') state.orderArgs.push(args);
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
		state.limitArgs = [];
		state.orderArgs = [];
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
					passwordHash: null
				}
			]
		];

		const data = await loadTimelineMegaData();

		expect(data.timelineItems).toEqual([
			{
				title: 'Trip',
				href: '/notes/trip',
				type: 'notes',
				locked: false,
				date: 'February 1, 2026'
			},
			{ title: 'Post A', href: '/posts/a', type: 'posts', locked: false, date: 'January 15, 2026' }
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
					passwordHash: '$argon2id$stub'
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
		// Recent notes are capped by the query limit (no post-slice).
		expect(state.limitArgs).toContain(4);
	});

	it('slices the mega menu topic list to its limit', async () => {
		state.selectResults = [
			Array.from({ length: 6 }, (_, index) => ({
				id: `t${index}`,
				name: `Topic ${index}`,
				slug: `topic-${index}`,
				icon: null,
				total: 1
			})),
			[],
			[{ total: 0 }]
		];

		const data = await loadNotesMegaData();

		expect(data.leftItems).toHaveLength(5);
		expect(data.leftItems?.[0]).toEqual({
			label: 'Topic 0',
			href: '/notes/topics/topic-0',
			iconName: undefined,
			badge: 1
		});
	});

	it('merges the timeline deterministically on equal timestamps', async () => {
		const at = new Date(2026, 0, 15, 12);
		state.selectResults = [
			[{ slug: 'b', title: 'Post B', publishedAt: at }],
			[{ id: 'n1', slug: 'a', title: 'Note A', publishedAt: at, tz: null, passwordHash: null }]
		];

		const data = await loadTimelineMegaData();

		// Tie-break chain: time desc, then type ('notes' < 'posts'), then href.
		expect(data.timelineItems?.map((item) => item.title)).toEqual(['Note A', 'Post B']);
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

	it('maps the pages chrome data: defaults first, fallback labels, external hrefs', async () => {
		state.selectResults = [
			[
				{
					slug: 'about',
					isDefault: true,
					title: { en: 'About Me', 'zh-cn': '关于我' },
					icon: null,
					externalUrl: null
				},
				{
					slug: 'about-site',
					isDefault: true,
					title: { 'zh-cn': '关于本项目' },
					icon: 'home',
					externalUrl: null
				},
				{
					slug: 'sponsor',
					isDefault: false,
					title: { ja: 'スポンサー' },
					icon: null,
					externalUrl: 'https://buymeacoffee.com/x'
				}
			]
		];

		const data = await loadPagesMegaData();

		expect(data.leftItems).toEqual([
			{ label: 'About Me', href: '/about', iconName: undefined },
			{ label: '关于本项目', href: '/about-site', iconName: 'home' },
			{ label: 'スポンサー', href: 'https://buymeacoffee.com/x', iconName: undefined }
		]);
		expect(data.footerDefaults).toEqual([
			{ label: 'About Me', href: '/about' },
			{ label: '关于本项目', href: '/about-site' }
		]);

		// Visibility + chrome order stay in SQL (row-level V1): status filter,
		// then is_default desc → sort_order asc → created_at asc.
		expect(state.whereArgs).toHaveLength(1);
		expect(dialect.sqlToQuery(state.whereArgs[0] as never).sql).toContain('"pages"."status"');
		const order = (state.orderArgs[0] as unknown[]).map(
			(fragment) => dialect.sqlToQuery(fragment as never).sql
		);
		expect(order).toHaveLength(3);
		expect(order[0]).toContain('"pages"."is_default"');
		expect(order[0].toLowerCase()).toContain('desc');
		expect(order[1]).toContain('"pages"."sort_order"');
		expect(order[2]).toContain('"pages"."created_at"');
	});
});

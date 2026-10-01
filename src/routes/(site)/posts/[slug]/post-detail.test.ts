import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the posts/[slug] load (P3-b): the slug fallback
 * chain. A retired slug resolves through slug_trackers to the single 301
 * redirect (one hop — trackers point at the row id); an invisible, missing
 * or self-referencing target is a plain 404, and the missing-language hint
 * keeps its behaviour when no tracker matches. The db module is mocked with
 * a queue of select results (P1.1 route-test pattern).
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], whereArgs: [] as unknown[] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireUser: vi.fn() }));
vi.mock('$lib/server/services/comments', () => ({
	loadThreads: vi.fn(async () => []),
	resolveCommentPostTarget: vi.fn(),
	submitComment: vi.fn()
}));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`,
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));
vi.mock('$lib/server/markdown', () => ({ renderMarkdownToHtml: vi.fn(async () => '') }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { load } from './+page.server';

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
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

const selectMock = vi.fn(() => makeChain(state.selectResults.shift() ?? []));
const selectDistinctMock = vi.fn(() => makeChain(state.selectResults.shift() ?? []));

function makeEvent(slug = 'old-slug', search = '') {
	return {
		locals: { user: null },
		params: { slug },
		url: new URL(`http://localhost/en/posts/${slug}${search}`)
	} as never;
}

const postRow = {
	id: 'post-1',
	slug: 'current-slug',
	title: 'Title',
	content: '',
	publishedAt: new Date('2026-09-30T00:00:00Z'),
	categoryName: 'Cat',
	allowComment: false,
	translationGroup: 'group-1'
};

describe('posts/[slug] load — slug fallback chain', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.whereArgs = [];
		selectMock.mockClear();
		selectDistinctMock.mockClear();
		Object.assign(dbMock, { select: selectMock, selectDistinct: selectDistinctMock });
	});

	it('serves the post on a direct hit with the translation group hreflang set', async () => {
		state.selectResults = [
			[postRow],
			[
				{ lang: 'en', slug: 'current-slug' },
				{ lang: 'zh-cn', slug: 'current-slug-zh' }
			]
		];

		const data = (await load(makeEvent('current-slug'))) as {
			post: { slug: string };
			seo: { path: string; alternates: { lang: string; path: string }[] };
		};

		expect(data.post.slug).toBe('current-slug');
		expect(selectMock).toHaveBeenCalledTimes(2);
		// hreflang set: the translation group's visible languages in locale order.
		expect(data.seo.path).toBe('/posts/current-slug');
		expect(data.seo.alternates).toEqual([
			{ lang: 'en', path: '/posts/current-slug' },
			{ lang: 'zh-cn', path: '/posts/current-slug-zh' }
		]);
	});

	it('redirects a retired slug to the current one with a single 301 hop', async () => {
		state.selectResults = [[], [{ targetId: 'post-1' }], [{ slug: 'current-slug' }]];

		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({
			status: 301,
			location: '/en/posts/current-slug'
		});
		expect(selectMock).toHaveBeenCalledTimes(3);
	});

	it('preserves the query string on the 301 (review finding)', async () => {
		state.selectResults = [[], [{ targetId: 'post-1' }], [{ slug: 'current-slug' }]];

		await expect(load(makeEvent('old-slug', '?utm_source=newsletter'))).rejects.toMatchObject({
			status: 301,
			location: '/en/posts/current-slug?utm_source=newsletter'
		});
	});

	it('404s when the tracked target is invisible or missing — never redirects', async () => {
		state.selectResults = [[], [{ targetId: 'post-1' }], []];

		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({ status: 404 });
	});

	it('404s on a self-referencing tracker (loop guard)', async () => {
		state.selectResults = [[], [{ targetId: 'post-1' }], [{ slug: 'old-slug' }]];

		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({ status: 404 });
	});

	it('keeps the missing-language hint when no tracker matches', async () => {
		state.selectResults = [[], [], [{ lang: 'zh-cn' }]];

		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({
			status: 404,
			body: { available: [{ lang: 'zh-cn', href: '/zh-cn/posts/old-slug' }] }
		});
	});

	it('sorts and dedupes the available-languages hint (review finding)', async () => {
		state.selectResults = [
			[],
			[],
			[{ lang: 'ja' }, { lang: 'zh-cn' }, { lang: 'en' }, { lang: 'zh-cn' }]
		];

		await expect(load(makeEvent('multi'))).rejects.toMatchObject({
			status: 404,
			body: {
				available: [
					{ lang: 'en', href: '/en/posts/multi' },
					{ lang: 'zh-cn', href: '/zh-cn/posts/multi' },
					{ lang: 'ja', href: '/ja/posts/multi' }
				]
			}
		});
	});

	it('404s plainly when neither tracker nor sibling language matches', async () => {
		state.selectResults = [[], []];

		await expect(load(makeEvent('ghost'))).rejects.toMatchObject({
			status: 404,
			body: { message: 'Not found' }
		});
	});

	it('pins the SQL guards on every query of the fallback chain (review finding)', async () => {
		// Direct hit: main query + siblings both carry locale + visibility guards.
		state.selectResults = [[postRow], [{ lang: 'en', slug: 'current-slug' }]];
		await load(makeEvent('current-slug'));
		const mainSql = dialect.sqlToQuery(state.whereArgs[0] as never).sql;
		expect(mainSql).toContain('"posts"."lang"');
		expect(mainSql).toContain('"posts"."slug"');
		expect(mainSql).toContain('"posts"."status"');
		const siblingSql = dialect.sqlToQuery(state.whereArgs[1] as never).sql;
		expect(siblingSql).toContain('"posts"."translation_group"');
		expect(siblingSql).toContain('"posts"."status"');

		// Retired slug: the redirect target stays inside the locale's visible set.
		state.whereArgs = [];
		state.selectResults = [[], [{ targetId: 'post-1' }], [{ slug: 'current-slug' }]];
		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({ status: 301 });
		const targetSql = dialect.sqlToQuery(state.whereArgs[2] as never).sql;
		expect(targetSql).toContain('"posts"."id"');
		expect(targetSql).toContain('"posts"."lang"');
		expect(targetSql).toContain('"posts"."status"');

		// Missing-language hint: same slug, other languages, visible only.
		state.whereArgs = [];
		state.selectResults = [[], [], [{ lang: 'zh-cn' }]];
		await expect(load(makeEvent('old-slug'))).rejects.toMatchObject({ status: 404 });
		const hintSql = dialect.sqlToQuery(state.whereArgs[2] as never).sql;
		expect(hintSql).toContain('"posts"."slug"');
		expect(hintSql).toContain('<>');
		expect(hintSql).toContain('"posts"."status"');
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
	state: { selectResults: [] as unknown[][] }
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
				return () => self;
			}
		}
	);
	return self;
}

const selectMock = vi.fn(() => makeChain(state.selectResults.shift() ?? []));
const selectDistinctMock = vi.fn(() => makeChain(state.selectResults.shift() ?? []));

function makeEvent(slug = 'old-slug') {
	return {
		locals: { user: null },
		params: { slug },
		url: new URL(`http://localhost/en/posts/${slug}`)
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

	it('404s plainly when neither tracker nor sibling language matches', async () => {
		state.selectResults = [[], []];

		await expect(load(makeEvent('ghost'))).rejects.toMatchObject({
			status: 404,
			body: { message: 'Not found' }
		});
	});
});

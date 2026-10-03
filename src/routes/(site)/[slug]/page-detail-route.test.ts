import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the universal md-page route (P1b): strict language
 * serving (missing locale → 404 with an ordered hint, never a fallback),
 * external / contentless rows as plain 404s, hidden rows directly reachable,
 * display-field fallback for the head, and the content-locales hreflang set.
 * The db module is mocked with a queue of select results; the pages service
 * runs for real on top of it.
 */
const { dbMock, state, renderMarkdownToHtml } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][] },
	renderMarkdownToHtml: vi.fn(async (md: string) => `<rendered>${md}</rendered>`)
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/markdown', () => ({ renderMarkdownToHtml }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`,
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

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

const pageRow = {
	id: 'p-1',
	slug: 'about',
	title: { en: 'About Me', 'zh-cn': '关于我' },
	description: { en: 'About desc' },
	content: { en: '# About\n\nBody', 'zh-cn': '# 关于' },
	externalUrl: null,
	status: 'visible',
	icon: null,
	isDefault: false,
	sortOrder: 1
};

function makeEvent(slug = 'about') {
	return { params: { slug } } as never;
}

describe('(site)/[slug] load — universal md page', () => {
	beforeEach(() => {
		state.selectResults = [];
		renderMarkdownToHtml.mockClear();
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('serves the current-locale body with the content-locales hreflang set', async () => {
		state.selectResults = [[pageRow]];

		const data = (await load(makeEvent())) as {
			seo: { path: string; alternates: { lang: string; path: string }[] };
			page: { slug: string; title: string; description: string | null };
			html: string;
		};

		expect(renderMarkdownToHtml).toHaveBeenCalledWith('# About\n\nBody');
		expect(data.html).toContain('rendered');
		expect(data.seo.path).toBe('/about');
		expect(data.seo.alternates).toEqual([
			{ lang: 'en', path: '/about' },
			{ lang: 'zh-cn', path: '/about' }
		]);
		expect(data.page).toEqual({ slug: 'about', title: 'About Me', description: 'About desc' });
	});

	it('404s with an ordered language hint when the body lacks the locale (strict serving)', async () => {
		state.selectResults = [[{ ...pageRow, content: { 'zh-cn': '# 关于', ja: '# 情報' } }]];

		await expect(load(makeEvent())).rejects.toMatchObject({
			status: 404,
			body: {
				message: 'error_page_language_hint',
				available: [
					{ lang: 'zh-cn', href: '/zh-cn/about' },
					{ lang: 'ja', href: '/ja/about' }
				]
			}
		});
		expect(renderMarkdownToHtml).not.toHaveBeenCalled();
	});

	it('404s for unknown slugs, external rows and rows without content', async () => {
		state.selectResults = [
			[],
			[{ ...pageRow, externalUrl: 'https://example.com' }],
			[{ ...pageRow, content: null }]
		];

		for (let i = 0; i < 3; i += 1) {
			await expect(load(makeEvent())).rejects.toMatchObject({ status: 404 });
		}
	});

	it('serves hidden rows directly (hiding is a menu-level concern)', async () => {
		state.selectResults = [[{ ...pageRow, status: 'hidden' }]];

		const data = (await load(makeEvent())) as { html: string };

		expect(data.html).toContain('rendered');
	});

	it('404s without a hint when the content object carries no usable locale', async () => {
		state.selectResults = [[{ ...pageRow, content: {} }]];

		await expect(load(makeEvent())).rejects.toMatchObject({
			status: 404,
			body: { message: 'Not found' }
		});
	});

	it('falls display fields back through the chain while the body stays strict', async () => {
		state.selectResults = [[{ ...pageRow, title: { 'zh-cn': '关于我' }, description: null }]];

		const data = (await load(makeEvent())) as {
			page: { title: string; description: string | null };
		};

		expect(data.page.title).toBe('关于我');
		expect(data.page.description).toBeNull();
	});

	it('404s locale-shaped slugs before touching the registry (P1b review belt)', async () => {
		await expect(load(makeEvent('en'))).rejects.toMatchObject({ status: 404 });
		await expect(load(makeEvent('zh-cn'))).rejects.toMatchObject({ status: 404 });
		await expect(load(makeEvent('ja'))).rejects.toMatchObject({ status: 404 });
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('hints only locales that truly carry content (blank and unknown keys excluded)', async () => {
		state.selectResults = [[{ ...pageRow, content: { en: '   ', 'zh-cn': '# 关于', fr: 'x' } }]];

		await expect(load(makeEvent())).rejects.toMatchObject({
			status: 404,
			body: {
				message: 'error_page_language_hint',
				available: [{ lang: 'zh-cn', href: '/zh-cn/about' }]
			}
		});
	});
});

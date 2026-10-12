import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the universal md-page route (P1b): strict language
 * serving (missing locale → 404 with an ordered hint, never a fallback),
 * external / contentless rows as plain 404s, hidden rows directly reachable,
 * display-field fallback for the head, and the content-locales hreflang set.
 * The db module is mocked with a queue of select results; the pages service
 * runs for real on top of it.
 */
const { dbMock, state, service, renderMarkdownToHtml } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][] },
	service: {
		loadThreads: vi.fn(),
		resolveCommentPageTarget: vi.fn(),
		submitComment: vi.fn(),
		commentEditAction: vi.fn(),
		commentDeleteAction: vi.fn(),
		requireUser: vi.fn()
	},
	renderMarkdownToHtml: vi.fn(async (md: string) => `<rendered>${md}</rendered>`)
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/markdown', () => ({ renderMarkdownToHtml }));
vi.mock('$lib/server/services/comments', () => ({
	loadThreads: service.loadThreads,
	resolveCommentPageTarget: service.resolveCommentPageTarget,
	submitComment: service.submitComment,
	// Imported by the real comments-actions adapter below; never called here
	// (its handlers are mocked) but the binding must exist.
	editComment: vi.fn(),
	deleteComment: vi.fn()
}));
vi.mock('$lib/server/services/comments-actions', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('$lib/server/services/comments-actions')>();
	return {
		commentEditAction: service.commentEditAction,
		commentDeleteAction: service.commentDeleteAction,
		// The real mapping: the route's submit path rides on it (pre-release
		// review 01-P2-1) - the mock must not fake it away.
		commentSubmitResponse: actual.commentSubmitResponse
	};
});
vi.mock('$lib/server/authz', () => ({ requireUser: service.requireUser }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`,
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { actions, load } from './+page.server';

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

const threads = { roots: [], visibleCount: 0, truncated: false };

function makeEvent(slug = 'about', overrides: Record<string, unknown> = {}) {
	return {
		params: { slug },
		url: new URL('http://localhost/en/about'),
		locals: { user: null, profile: null },
		...overrides
	} as never;
}

beforeEach(() => {
	state.selectResults = [];
	renderMarkdownToHtml.mockClear();
	for (const fn of Object.values(service)) fn.mockReset?.();
	service.loadThreads.mockResolvedValue(threads);
	service.resolveCommentPageTarget.mockResolvedValue(null);
	service.submitComment.mockResolvedValue({ kind: 'created', id: 'c-1', state: 'pending' });
	service.requireUser.mockReturnValue({ id: 'u-1', name: 'Reader', emailVerified: true });
	Object.assign(dbMock, {
		select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
	});
});

describe('(site)/[slug] load — universal md page', () => {
	it('serves the current-locale body with the content-locales hreflang set', async () => {
		state.selectResults = [[pageRow]];

		const data = (await load(makeEvent())) as {
			seo: { path: string; alternates: { lang: string; path: string }[] };
			page: { slug: string; title: string; description: string | null };
			html: string;
			viewer: { emailVerified: boolean; canComment: boolean; loginUrl: string | null };
			discussion: unknown;
		};

		expect(renderMarkdownToHtml).toHaveBeenCalledWith('# About\n\nBody');
		expect(data.html).toContain('rendered');
		expect(data.seo.path).toBe('/about');
		expect(data.seo.alternates).toEqual([
			{ lang: 'en', path: '/about' },
			{ lang: 'zh-cn', path: '/about' }
		]);
		expect(data.page).toEqual({ slug: 'about', title: 'About Me', description: 'About desc' });
		// P4 comment mount: guests get the login link; the threads always load
		// (pages carry no per-row switch).
		expect(data.viewer).toEqual({
			emailVerified: false,
			canComment: false,
			loginUrl: '/login?redirectTo=%2Fen%2Fabout'
		});
		expect(data.discussion).toEqual(threads);
		expect(service.loadThreads).toHaveBeenCalledWith({
			targetType: 'page',
			targetId: 'p-1',
			viewerId: null
		});
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

	it('passes the viewer through: signed-in readers load their own threads', async () => {
		state.selectResults = [[pageRow]];

		const data = (await load(
			makeEvent('about', {
				locals: { user: { id: 'u-9', emailVerified: true }, profile: null }
			})
		)) as { viewer: { emailVerified: boolean; canComment: boolean; loginUrl: string | null } };

		expect(data.viewer).toEqual({ emailVerified: true, canComment: true, loginUrl: null });
		expect(service.loadThreads).toHaveBeenCalledWith({
			targetType: 'page',
			targetId: 'p-1',
			viewerId: 'u-9'
		});
	});
});

describe('(site)/[slug] comment actions (P4 mount)', () => {
	it('submits through the slug-resolved page target', async () => {
		service.resolveCommentPageTarget.mockResolvedValue('p-1');
		const fd = new FormData();
		fd.set('text', 'hello page');

		const result = await actions.comment(
			makeEvent('about', { request: { formData: vi.fn(async () => fd) } })
		);

		expect(result).toEqual({ submitted: 'pending' });
		expect(service.resolveCommentPageTarget).toHaveBeenCalledWith('en', 'about');
		expect(service.submitComment).toHaveBeenCalledWith({
			targetType: 'page',
			targetId: 'p-1',
			lang: 'en',
			parentId: null,
			text: 'hello page',
			user: { id: 'u-1', name: 'Reader', emailVerified: true },
			author: 'Reader',
			avatar: null,
			now: expect.any(Date)
		});
	});

	it('maps the service failures onto the localized responses', async () => {
		service.resolveCommentPageTarget.mockResolvedValue('p-1');
		const cases: Array<[string, number, string]> = [
			['throttled', 429, 'comment_throttled'],
			['unverified', 403, 'comment_verify_hint'],
			['parent-unavailable', 400, 'comment_error_parent'],
			['target-unavailable', 404, 'comment_error_unavailable'],
			['empty', 400, 'comment_error_generic'],
			['too-long', 400, 'comment_error_generic']
		];
		for (const [kind, status, message] of cases) {
			service.submitComment.mockResolvedValue({ kind });
			const fd = new FormData();
			fd.set('text', 'x');
			const result = await actions.comment(
				makeEvent('about', { request: { formData: vi.fn(async () => fd) } })
			);
			expect(result, kind).toMatchObject({ status, data: { message } });
		}
	});

	it('reads the parentId for replies only, mirroring the posts host', async () => {
		service.resolveCommentPageTarget.mockResolvedValue('p-1');
		const fd = new FormData();
		fd.set('text', 'r');
		fd.set('parentId', 'aaaaaaaa-1111-1111-1111-111111111111');
		const request = { request: { formData: vi.fn(async () => fd) } };

		await actions.comment(makeEvent('about', request));
		expect(service.submitComment).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));

		await actions.reply(makeEvent('about', request));
		expect(service.submitComment).toHaveBeenLastCalledWith(
			expect.objectContaining({ parentId: 'aaaaaaaa-1111-1111-1111-111111111111' })
		);
	});

	it('blocks unverified readers before resolution or submit (posts twin)', async () => {
		service.requireUser.mockReturnValue({ id: 'u-1', name: 'Reader', emailVerified: false });
		const fd = new FormData();
		fd.set('text', 'hi');
		const result = await actions.comment(
			makeEvent('about', { request: { formData: vi.fn(async () => fd) } })
		);
		expect(result).toMatchObject({ status: 403, data: { message: 'comment_verify_hint' } });
		expect(service.resolveCommentPageTarget).not.toHaveBeenCalled();
		expect(service.submitComment).not.toHaveBeenCalled();
	});

	it('404s when the slug no longer resolves to a commentable page', async () => {
		const fd = new FormData();
		fd.set('text', 'x');

		const result = await actions.comment(
			makeEvent('about', { request: { formData: vi.fn(async () => fd) } })
		);

		expect(result).toMatchObject({ status: 404, data: { message: 'comment_error_unavailable' } });
		expect(service.submitComment).not.toHaveBeenCalled();
	});

	it('wires edit and delete onto the shared handlers (single home)', () => {
		expect(actions.edit).toBe(service.commentEditAction);
		expect(actions.delete).toBe(service.commentDeleteAction);
	});
});

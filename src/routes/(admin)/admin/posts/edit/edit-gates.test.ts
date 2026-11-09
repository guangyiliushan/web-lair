import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the editor's language defaults (Task A5).
 *
 * The two UI gates are gone, so a new article no longer waits for an explicit
 * source language or category before its first save. The load therefore has
 * to hand the editor the author's language through `resolveWriterLang`, while
 * an existing post keeps the language stored on its own row. The db module is
 * mocked with the same recording chain as the sibling route tests.
 */
const { dbMock, state, resolver } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectQueue: [] as unknown[][] },
	resolver: vi.fn<(userId: string | null) => Promise<string>>()
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/writer-lang', () => ({ resolveWriterLang: resolver }));
vi.mock('$lib/server/services/post-drafts', () => ({
	saveDraftWork: vi.fn(),
	publishDraft: vi.fn(),
	discardDraft: vi.fn(),
	createTranslationDraft: vi.fn(),
	loadDraftByPostId: vi.fn(async () => null),
	isPlaceholderSlug: vi.fn((slug: string) => slug.startsWith('draft-'))
}));
vi.mock('$lib/server/services/summaries', () => ({
	enqueueSummaryAfterPublish: vi.fn(),
	listSummaries: vi.fn(async () => []),
	generateAndStoreSummary: vi.fn(),
	adoptSummary: vi.fn(),
	discardSummary: vi.fn()
}));
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: vi.fn() }));

import { getOption } from '$lib/server/config/options-registry';
import { load } from './+page.server';

const CAT_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_ID = '22222222-2222-2222-2222-222222222222';
const POST_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';

const POST_ROW = {
	id: POST_ID,
	title: 'Existing',
	slug: 'existing',
	categoryId: CAT_ID,
	summary: '',
	content: '',
	status: 'published',
	lang: 'zh-cn',
	version: 2,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-02T00:00:00Z'),
	translatedFromPostId: null,
	writingOrigin: null,
	aiHelp: [],
	translationGroup: POST_ID
};

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		innerJoin: ret,
		// The drawer's presence read joins `drafts`; an id load reaches it.
		leftJoin: ret,
		limit: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(resolve, reject)
	});
	return chain;
}

type LoadResult = {
	defaultLang: string;
	post: { id: string; lang: string } | null;
};

async function runLoad(userId: string | null, search = '') {
	const data = await load({
		url: new URL(`http://x/admin/posts/edit${search}`),
		locals: { user: userId ? { id: userId } : null }
	} as never);
	return data as unknown as LoadResult;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.selectQueue = [];
	dbMock.select = vi.fn(() => selectChain());
	resolver.mockResolvedValue('en');
});

describe('editor load: new article language', () => {
	it('seeds the language from the author resolver, not site.default_lang', async () => {
		resolver.mockResolvedValue('ja');
		state.selectQueue = [[{ id: CAT_ID, name: 'Tech', slug: 'tech' }], [{ id: DEFAULT_ID }]];

		const data = await runLoad(USER_ID);

		expect(data.defaultLang).toBe('ja');
		expect(resolver).toHaveBeenCalledWith(USER_ID);
		// The site option stays the resolver's own fallback; this route must not
		// read it as a second source of truth.
		expect(vi.mocked(getOption)).not.toHaveBeenCalledWith('site.default_lang');
	});

	it('asks the resolver for a null author when the request is signed out', async () => {
		state.selectQueue = [[], []];

		await runLoad(null);

		expect(resolver).toHaveBeenCalledWith(null);
	});

	it('keeps an existing post language while the default still comes from the resolver', async () => {
		resolver.mockResolvedValue('ja');
		state.selectQueue = [
			[{ id: CAT_ID, name: 'Tech', slug: 'tech' }],
			[{ id: DEFAULT_ID }],
			[POST_ROW],
			[{ name: 'tagged' }],
			[]
		];

		const data = await runLoad(USER_ID, `?id=${POST_ID}`);

		expect(data.post?.lang).toBe('zh-cn');
		expect(data.defaultLang).toBe('ja');
	});
});

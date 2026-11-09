import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the drawer's data riding on the editor load (Task B5).
 *
 * Opening the drawer must not cost a request, so the load has to ship the
 * group's candidates, its presence map and the group source id. The group is
 * always the source row's group: a translation row's own id is never the
 * source, and a brand-new article has no group at all.
 */
const { dbMock, state, services } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectQueue: [] as unknown[][] },
	services: {
		listCandidatesForGroup: vi.fn(),
		translationPresenceForGroup: vi.fn()
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/writer-lang', () => ({ resolveWriterLang: vi.fn(async () => 'en') }));
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
// The two drawer reads are mocked (they have their own suites); this test pins
// that the load asks for the post group and surfaces what they answer.
vi.mock('$lib/server/services/translations', () => ({
	enqueueTranslationsAfterPublish: vi.fn(),
	requestTranslation: vi.fn(),
	listCandidatesForGroup: services.listCandidatesForGroup
}));
vi.mock('$lib/server/services/translation-presence', () => ({
	translationPresenceForGroup: services.translationPresenceForGroup
}));

import { load } from './+page.server';

const CAT_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_ID = '22222222-2222-2222-2222-222222222222';
const TRANSLATION_ID = '33333333-3333-3333-3333-333333333333';
const SOURCE_ID = '44444444-4444-4444-4444-444444444444';
const GROUP = '55555555-5555-5555-5555-555555555555';

type LoadResult = {
	post: { id: string; lang: string } | null;
	source: { id: string; lang: string } | null;
	translationGroup: string | null;
	translationCandidates: unknown[];
	translationPresence: Record<string, unknown>;
	sourcePostId: string | null;
};

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		innerJoin: ret,
		leftJoin: ret,
		limit: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(resolve, reject)
	});
	return chain;
}

const TRANSLATION_ROW = {
	id: TRANSLATION_ID,
	title: '译文',
	slug: 'translated',
	categoryId: CAT_ID,
	summary: '',
	content: '',
	status: 'draft',
	lang: 'zh-cn',
	version: 1,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-02T00:00:00Z'),
	translatedFromPostId: SOURCE_ID,
	writingOrigin: null,
	aiHelp: [],
	translationGroup: GROUP
};

const SOURCE_ROW = {
	id: SOURCE_ID,
	title: 'Source',
	slug: 'source',
	lang: 'en',
	writingOrigin: null,
	aiHelp: []
};

const CANDIDATE = {
	id: '66666666-6666-6666-6666-666666666666',
	targetLang: 'ja',
	status: 'draft',
	title: 'ドラフト',
	content: '本文',
	summary: null,
	model: 'stub',
	error: null,
	sourceHash: null,
	updatedAt: new Date('2026-01-03T00:00:00Z')
};

const PRESENCE = {
	en: { postId: SOURCE_ID, status: 'published', hasContent: true },
	'zh-cn': { postId: TRANSLATION_ID, status: 'draft', hasContent: true },
	ja: { postId: '77777777-7777-7777-7777-777777777777', status: 'draft', hasContent: false }
};

async function runLoad(search = '') {
	const data = await load({
		url: new URL(`http://x/admin/posts/edit${search}`),
		locals: { user: { id: SOURCE_ID } }
	} as never);
	return data as unknown as LoadResult;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.selectQueue = [];
	dbMock.select = vi.fn(() => selectChain());
	services.listCandidatesForGroup.mockResolvedValue([CANDIDATE]);
	services.translationPresenceForGroup.mockResolvedValue(PRESENCE);
});

describe('editor load: translation drawer state', () => {
	it('reports the group source and ships presence keyed by language', async () => {
		state.selectQueue = [
			[{ id: CAT_ID, name: 'Tech', slug: 'tech' }],
			[{ id: DEFAULT_ID }],
			[TRANSLATION_ROW],
			[],
			[SOURCE_ROW],
			[{ id: SOURCE_ID, lang: 'en', status: 'published' }]
		];

		const data = await runLoad(`?id=${TRANSLATION_ID}`);

		expect(data.sourcePostId).toBe(data.source?.id);
		expect(data.sourcePostId).toBe(SOURCE_ID);
		expect(data.translationGroup).toBe(GROUP);
		expect(services.listCandidatesForGroup).toHaveBeenCalledWith('post', GROUP);
		expect(services.translationPresenceForGroup).toHaveBeenCalledWith('post', GROUP);
		// Language codes, never the group's row ids: the ruler reads `presence[lang]`.
		expect(Object.keys(data.translationPresence).sort()).toEqual(['en', 'ja', 'zh-cn']);
		expect(data.translationPresence[TRANSLATION_ID]).toBeUndefined();
		expect(data.translationPresence['zh-cn']).toEqual(PRESENCE['zh-cn']);
		expect(data.translationCandidates).toHaveLength(1);
		expect(data.translationCandidates[0]).toMatchObject({ targetLang: 'ja' });
	});

	it('asks for nothing and ships empty state for a brand-new article', async () => {
		state.selectQueue = [[{ id: CAT_ID, name: 'Tech', slug: 'tech' }], [{ id: DEFAULT_ID }], []];

		const data = await runLoad();

		expect(data.translationGroup).toBeNull();
		expect(data.translationCandidates).toEqual([]);
		expect(data.translationPresence).toEqual({});
		expect(data.sourcePostId).toBeNull();
		expect(services.listCandidatesForGroup).not.toHaveBeenCalled();
		expect(services.translationPresenceForGroup).not.toHaveBeenCalled();
	});
});

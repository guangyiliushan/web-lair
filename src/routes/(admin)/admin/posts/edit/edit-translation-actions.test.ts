import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the drawer's actions. The drawer must
 * generate, accept, retry, discard and resync without leaving the editor, so
 * every action answers with data instead of redirecting, and every failure
 * speaks the workbench's copy. Services and db are mocked; the mapping from
 * service result to response is what this suite pins.
 */
const { dbMock, state, services } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectQueue: [] as unknown[][] },
	services: {
		requireAdminRole: vi.fn(),
		listCandidatesForGroup: vi.fn(),
		translationPresenceForGroup: vi.fn(),
		requestTranslation: vi.fn(),
		requestRetranslation: vi.fn(),
		acceptTranslation: vi.fn(),
		retryTranslation: vi.fn(),
		discardTranslation: vi.fn(),
		resyncTranslation: vi.fn()
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: services.requireAdminRole }));
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
vi.mock('$lib/server/services/translations', () => ({
	TRANSLATION_JOB: 'ai.translate',
	enqueueTranslationsAfterPublish: vi.fn(),
	listCandidatesForGroup: services.listCandidatesForGroup,
	requestTranslation: services.requestTranslation,
	requestRetranslation: services.requestRetranslation,
	acceptTranslation: services.acceptTranslation,
	retryTranslation: services.retryTranslation,
	discardTranslation: services.discardTranslation,
	resyncTranslation: services.resyncTranslation
}));
vi.mock('$lib/server/services/translation-presence', () => ({
	translationPresenceForGroup: services.translationPresenceForGroup
}));
vi.mock('$lib/server/ai/budget', () => ({
	readBudgetState: vi.fn(async () => ({
		monthly: 10,
		currency: 'USD',
		alertRatios: [0.8, 0.9, 1],
		pauseAutoOnExceed: true,
		spent: 0,
		unpricedCalls: 0,
		unpricedSuccessCalls: 0,
		paused: false
	}))
}));

import { actions } from './+page.server';
import { m } from '$lib/paraglide/messages';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Copy assertions read the catalog instead of hardcoding one locale.
overwriteGetLocale(() => 'en');

const POST_ID = '22222222-2222-2222-2222-222222222222';
const TARGET_ID = '33333333-3333-3333-3333-333333333333';
const CANDIDATE_ID = '44444444-4444-4444-4444-444444444444';
const GROUP = '55555555-5555-5555-5555-555555555555';

const ACTION_NAMES = [
	'translationStatus',
	'requestTranslation',
	'retranslateDraft',
	'acceptTranslation',
	'retryTranslation',
	'discardTranslation',
	'resyncTranslation'
];

const CANDIDATE = {
	id: CANDIDATE_ID,
	targetLang: 'ja',
	status: 'draft',
	title: 'ドラフト',
	content: '本文',
	summary: null,
	model: 'stub',
	error: null,
	sourceHash: null,
	stage: null,
	waitingReason: null,
	updatedAt: new Date('2026-01-03T00:00:00Z')
};

const PRESENCE = {
	en: { postId: POST_ID, status: 'published', hasContent: true },
	ja: { postId: TARGET_ID, status: 'draft', hasContent: false }
};

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/posts/edit', { method: 'POST', body }),
		locals: { admin: { userId: 'user-1', role: 'owner' } }
	};
}

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

async function callAction(name: string, fields: Record<string, string> = {}) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = await fn(makeEvent(fields) as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number; location?: string } };
	}
}

beforeEach(() => {
	vi.resetAllMocks();
	state.selectQueue = [];
	dbMock.select = vi.fn(() => selectChain());
	services.requireAdminRole.mockImplementation(async () => {});
});

describe('editor translation actions', () => {
	it('runs every action behind the admin guard first', async () => {
		for (const name of ACTION_NAMES) await callAction(name);

		expect(services.requireAdminRole).toHaveBeenCalledTimes(ACTION_NAMES.length);
		expect(services.listCandidatesForGroup).not.toHaveBeenCalled();
		expect(services.requestTranslation).not.toHaveBeenCalled();
		expect(services.requestRetranslation).not.toHaveBeenCalled();
		expect(services.acceptTranslation).not.toHaveBeenCalled();
		expect(services.retryTranslation).not.toHaveBeenCalled();
		expect(services.discardTranslation).not.toHaveBeenCalled();
		expect(services.resyncTranslation).not.toHaveBeenCalled();
	});

	it('stops the action when the guard rejects (no service call)', async () => {
		for (const name of ACTION_NAMES) {
			services.requireAdminRole.mockImplementationOnce(() => {
				throw Object.assign(new Error('redirect'), { status: 303, location: '/login' });
			});
			const { thrown } = await callAction(name, { id: POST_ID, group: GROUP, lang: 'ja' });
			expect(thrown?.status).toBe(303);
		}
		expect(services.requestTranslation).not.toHaveBeenCalled();
		expect(services.acceptTranslation).not.toHaveBeenCalled();
	});

	it('rejects malformed ids and unknown languages before calling a service', async () => {
		const badPostId = await callAction('translationStatus', { postId: 'nope' });
		expect(badPostId.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_err_bad_post_id() }
		});

		const badRequestId = await callAction('requestTranslation', { id: 'nope', lang: 'ja' });
		expect(badRequestId.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_err_bad_post_id() }
		});

		const badLang = await callAction('requestTranslation', { id: POST_ID, lang: 'xx-bogus' });
		expect(badLang.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_target_lang() }
		});

		const badRetranslateId = await callAction('retranslateDraft', { id: 'nope', lang: 'ja' });
		expect(badRetranslateId.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_err_bad_post_id() }
		});

		const badRetranslateLang = await callAction('retranslateDraft', {
			id: POST_ID,
			lang: 'xx-bogus'
		});
		expect(badRetranslateLang.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_target_lang() }
		});

		for (const name of [
			'acceptTranslation',
			'retryTranslation',
			'discardTranslation',
			'resyncTranslation'
		]) {
			const { result } = await callAction(name, { id: 'nope' });
			expect(result).toMatchObject({
				status: 400,
				data: { message: m.admin_translations_err_bad_id() }
			});
		}

		expect(services.listCandidatesForGroup).not.toHaveBeenCalled();
		expect(services.translationPresenceForGroup).not.toHaveBeenCalled();
		expect(services.requestTranslation).not.toHaveBeenCalled();
		expect(services.requestRetranslation).not.toHaveBeenCalled();
		expect(services.acceptTranslation).not.toHaveBeenCalled();
		expect(services.retryTranslation).not.toHaveBeenCalled();
		expect(services.discardTranslation).not.toHaveBeenCalled();
		expect(services.resyncTranslation).not.toHaveBeenCalled();
	});

	it('answers translationStatus with the row group candidates and presence map', async () => {
		state.selectQueue = [
			[{ translationGroup: GROUP }],
			[{ status: 'queued', createdAt: new Date(Date.now() - 120_000), startedAt: null }]
		];
		services.listCandidatesForGroup.mockResolvedValue([CANDIDATE]);
		services.translationPresenceForGroup.mockResolvedValue(PRESENCE);

		const { result } = await callAction('translationStatus', { postId: ` ${POST_ID} ` });

		expect(result).toMatchObject({
			candidates: [CANDIDATE],
			presence: PRESENCE,
			// Job liveness rides the same payload: a queued run with no start
			// is what lets the drawer say "waiting" instead of "generating".
			job: { queuedAgeSec: expect.any(Number), runningSinceSec: null, lastStatus: 'queued' },
			// A paused budget explains an idle queue; the drawer paints it.
			budget: { paused: false, monthly: 10, spent: 0, currency: 'USD' }
		});
		expect(services.listCandidatesForGroup).toHaveBeenCalledWith('post', GROUP);
		expect(services.translationPresenceForGroup).toHaveBeenCalledWith('post', GROUP);
	});

	it('answers why the drawn language is parked', async () => {
		state.selectQueue = [[{ translationGroup: GROUP }]];
		services.listCandidatesForGroup.mockResolvedValue([
			{ ...CANDIDATE, stage: 'waiting', waitingReason: 'Rate limited (429)' }
		]);
		services.translationPresenceForGroup.mockResolvedValue(PRESENCE);

		const { result } = await callAction('translationStatus', { postId: POST_ID, lang: 'ja' });

		expect(result).toMatchObject({
			stage: 'waiting',
			waitingReason: 'Rate limited (429)'
		});
	});

	it('does not attribute one language’s park to another', async () => {
		state.selectQueue = [[{ translationGroup: GROUP }]];
		services.listCandidatesForGroup.mockResolvedValue([
			{ ...CANDIDATE, stage: 'waiting', waitingReason: 'Rate limited (429)' }
		]);
		services.translationPresenceForGroup.mockResolvedValue(PRESENCE);

		const { result } = await callAction('translationStatus', { postId: POST_ID, lang: 'en' });

		expect(result).toMatchObject({ stage: null, waitingReason: null });
	});

	it('404s translationStatus for a post id that no longer exists', async () => {
		const { result } = await callAction('translationStatus', { postId: POST_ID });

		expect(result).toMatchObject({
			status: 404,
			data: { message: m.admin_posts_edit_err_not_found() }
		});
		expect(services.listCandidatesForGroup).not.toHaveBeenCalled();
	});

	it('requestTranslation answers with the candidate id instead of redirecting', async () => {
		for (const kind of ['queued', 'exists'] as const) {
			services.requestTranslation.mockResolvedValueOnce({ kind, id: CANDIDATE_ID });
			const { result, thrown } = await callAction('requestTranslation', {
				id: POST_ID,
				lang: 'ja'
			});
			expect(thrown).toBeUndefined();
			expect(result).toEqual({ candidateId: CANDIDATE_ID });
		}
		expect(services.requestTranslation).toHaveBeenCalledWith({
			sourceType: 'post',
			sourceId: POST_ID,
			targetLang: 'ja',
			manual: true,
			// The admin who asked; the job copies it onto `ai_usage.actor_id`.
			requestedBy: 'user-1'
		});
	});

	it('requestTranslation maps its failure kinds to the shared copy', async () => {
		const cases = [
			[{ kind: 'too-short' }, m.admin_translations_err_too_short()],
			[{ kind: 'lang-exists' }, m.admin_translations_err_lang_exists()],
			[{ kind: 'same-lang' }, m.admin_translations_err_same_lang()],
			[{ kind: 'not-found' }, m.admin_translations_err_source_missing()],
			[{ kind: 'skipped', reason: 'not-source' }, m.admin_translations_err_not_source()],
			[{ kind: 'skipped', reason: 'empty-source' }, m.admin_translations_err_empty_source()],
			[{ kind: 'skipped', reason: 'bad-lang' }, m.admin_translations_err_generic()]
		] as const;

		for (const [outcome, message] of cases) {
			services.requestTranslation.mockResolvedValueOnce(outcome);
			const { result } = await callAction('requestTranslation', { id: POST_ID, lang: 'ja' });
			expect(result).toMatchObject({ status: 400, data: { message } });
		}
	});

	it('retranslateDraft queues a replacement and maps its refusals', async () => {
		services.requestRetranslation.mockResolvedValueOnce({ kind: 'queued', id: CANDIDATE_ID });
		const queued = await callAction('retranslateDraft', { id: POST_ID, lang: 'ja' });
		expect(queued.result).toEqual({ candidateId: CANDIDATE_ID });
		expect(services.requestRetranslation).toHaveBeenCalledWith({
			sourceType: 'post',
			sourceId: POST_ID,
			targetLang: 'ja'
		});

		// A published target is a conflict, not a bad request: the language has
		// a public URL, so nothing may be rewritten in place.
		services.requestRetranslation.mockResolvedValueOnce({ kind: 'target-published' });
		const published = await callAction('retranslateDraft', { id: POST_ID, lang: 'ja' });
		expect(published.result).toMatchObject({
			status: 409,
			data: { message: m.admin_translations_err_resync_published() }
		});

		services.requestRetranslation.mockResolvedValueOnce({ kind: 'not-found' });
		const missing = await callAction('retranslateDraft', { id: POST_ID, lang: 'ja' });
		expect(missing.result).toMatchObject({
			status: 404,
			data: { message: m.admin_posts_edit_err_not_found() }
		});

		services.requestRetranslation.mockResolvedValueOnce({ kind: 'same-lang' });
		const same = await callAction('retranslateDraft', { id: POST_ID, lang: 'ja' });
		expect(same.result).toMatchObject({
			status: 400,
			data: { message: m.admin_posts_edit_err_same_lang() }
		});

		services.requestRetranslation.mockResolvedValueOnce({
			kind: 'skipped',
			reason: 'empty-source'
		});
		const empty = await callAction('retranslateDraft', { id: POST_ID, lang: 'ja' });
		expect(empty.result).toMatchObject({
			status: 400,
			data: { message: m.admin_translations_err_empty_source() }
		});
	});

	it('acceptTranslation returns the target and flags the current post', async () => {
		services.acceptTranslation.mockResolvedValue({
			kind: 'accepted',
			targetId: POST_ID,
			targetType: 'post'
		});
		const current = await callAction('acceptTranslation', {
			id: CANDIDATE_ID,
			postId: POST_ID
		});
		expect(current.result).toEqual({ targetId: POST_ID, targetType: 'post', isCurrent: true });
		expect(services.acceptTranslation).toHaveBeenCalledWith(CANDIDATE_ID, 'user-1');

		services.acceptTranslation.mockResolvedValue({
			kind: 'accepted',
			targetId: TARGET_ID,
			targetType: 'post'
		});
		const sibling = await callAction('acceptTranslation', {
			id: CANDIDATE_ID,
			postId: POST_ID
		});
		expect(sibling.result).toMatchObject({ targetId: TARGET_ID, isCurrent: false });

		services.acceptTranslation.mockResolvedValue({
			kind: 'accepted',
			targetId: POST_ID,
			targetType: 'note'
		});
		const note = await callAction('acceptTranslation', { id: CANDIDATE_ID, postId: POST_ID });
		expect(note.result).toMatchObject({ targetType: 'note', isCurrent: false });
	});

	it('acceptTranslation maps conflicts to the shared copy', async () => {
		services.acceptTranslation.mockResolvedValueOnce({ kind: 'not-draft' });
		const notDraft = await callAction('acceptTranslation', {
			id: CANDIDATE_ID,
			postId: POST_ID
		});
		expect(notDraft.result).toMatchObject({
			status: 400,
			data: { message: m.admin_translations_err_not_draft() }
		});

		services.acceptTranslation.mockResolvedValueOnce({ kind: 'busy' });
		const busy = await callAction('acceptTranslation', { id: CANDIDATE_ID, postId: POST_ID });
		expect(busy.result).toMatchObject({
			status: 409,
			data: { message: m.admin_translations_err_busy() }
		});

		services.acceptTranslation.mockResolvedValueOnce({ kind: 'target-published' });
		const published = await callAction('acceptTranslation', {
			id: CANDIDATE_ID,
			postId: POST_ID
		});
		expect(published.result).toMatchObject({
			status: 400,
			data: { message: m.admin_translations_err_target_published() }
		});
	});

	it('retry and discard answer ok, and 404 a missing candidate', async () => {
		services.retryTranslation.mockResolvedValueOnce({ kind: 'queued' });
		expect((await callAction('retryTranslation', { id: CANDIDATE_ID })).result).toEqual({
			ok: true
		});
		expect(services.retryTranslation).toHaveBeenCalledWith(CANDIDATE_ID);

		services.discardTranslation.mockResolvedValueOnce({ kind: 'discarded' });
		expect((await callAction('discardTranslation', { id: CANDIDATE_ID })).result).toEqual({
			ok: true
		});
		expect(services.discardTranslation).toHaveBeenCalledWith(CANDIDATE_ID);

		services.retryTranslation.mockResolvedValueOnce({ kind: 'not-found' });
		const missing = await callAction('retryTranslation', { id: CANDIDATE_ID });
		expect(missing.result).toMatchObject({
			status: 404,
			data: { message: m.admin_translations_err_candidate_missing() }
		});
	});

	it('resync answers ok and pins a published target to 409', async () => {
		services.resyncTranslation.mockResolvedValueOnce({ kind: 'queued' });
		expect((await callAction('resyncTranslation', { id: CANDIDATE_ID })).result).toEqual({
			ok: true
		});
		expect(services.resyncTranslation).toHaveBeenCalledWith(CANDIDATE_ID);

		services.resyncTranslation.mockResolvedValueOnce({ kind: 'target-published' });
		const published = await callAction('resyncTranslation', { id: CANDIDATE_ID });
		expect(published.result).toMatchObject({
			status: 409,
			data: { message: m.admin_translations_err_resync_published() }
		});

		services.resyncTranslation.mockResolvedValueOnce({ kind: 'not-found' });
		const missing = await callAction('resyncTranslation', { id: CANDIDATE_ID });
		expect(missing.result).toMatchObject({
			status: 404,
			data: { message: m.admin_translations_err_candidate_missing() }
		});
	});
});

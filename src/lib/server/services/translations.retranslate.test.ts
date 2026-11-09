import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retranslation wiring: an operator may ask for a fresh body for a language
 * that already has a draft, and that request must survive the accept guard
 * which normally protects a copy-prefill or hand-written draft from the first
 * AI write. Both halves are pinned here because either one alone leaves the
 * button unable to finish what its confirmation promised.
 */
const { dbMock, state, enqueueJobMock, tx } = vi.hoisted(() => {
	const state = {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		updates: [] as { values: Record<string, unknown> }[],
		inserts: [] as Record<string, unknown>[]
	};
	return {
		dbMock: {} as Record<string, unknown>,
		tx: {} as Record<string, unknown>,
		state,
		enqueueJobMock: vi.fn(async () => ({ id: 'job-1', deduplicated: false }))
	};
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: enqueueJobMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => ({ minChars: 0, defaultMode: 'manual' })),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/ai/translate', () => ({ sourceHash: () => 'source-hash' }));
vi.mock('./translation-presence', () => ({ hasUsableTranslation: vi.fn(async () => false) }));
vi.mock('./post-drafts', () => ({
	isPlaceholderSlug: () => false,
	tempSlug: () => 'temp-slug'
}));
vi.mock('./file-references', () => ({
	keysFromContent: () => [],
	syncFileReferences: vi.fn(async () => {})
}));

import { acceptTranslation, requestRetranslation } from './translations';

const SRC = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';
const GROUP = '33333333-3333-3333-3333-333333333333';
const CANDIDATE = '44444444-4444-4444-4444-444444444444';

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		for: ret,
		innerJoin: ret,
		leftJoin: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(resolve, reject)
	});
	return chain;
}

function writeChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		set: (values: Record<string, unknown>) => {
			state.updates.push({ values });
			return chain;
		},
		values: (values: Record<string, unknown>) => {
			state.inserts.push(values);
			return chain;
		},
		where: ret,
		onConflictDoNothing: ret,
		returning: async () => state.returningQueue.shift() ?? [],
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(undefined).then(resolve, reject)
	});
	return chain;
}

const source = {
	id: SRC,
	title: '源文',
	content: '源文正文',
	summary: null,
	lang: 'zh-cn',
	contentFormat: 'markdown',
	categoryId: 'cat-1',
	translationGroup: GROUP,
	translatedFrom: null,
	meta: null,
	status: 'published'
};

const draftTarget = { id: TARGET, status: 'draft' };

beforeEach(() => {
	state.selectQueue = [];
	state.returningQueue = [];
	state.updates = [];
	state.inserts = [];
	enqueueJobMock.mockClear();
	dbMock.transaction = vi.fn(async (callback: (executor: unknown) => unknown) => callback(tx));
	for (const executor of [dbMock, tx]) {
		executor.select = vi.fn(() => selectChain());
		executor.insert = vi.fn(() => writeChain());
		executor.update = vi.fn(() => writeChain());
	}
});

describe('requestRetranslation', () => {
	it('refuses a target that is no longer a draft', async () => {
		state.selectQueue = [[source], [{ id: TARGET, status: 'published' }]];

		await expect(
			requestRetranslation({ sourceType: 'post', sourceId: SRC, targetLang: 'ja' })
		).resolves.toEqual({ kind: 'target-published' });
		expect(enqueueJobMock).not.toHaveBeenCalled();
	});

	it('refuses a language that has no target row at all', async () => {
		state.selectQueue = [[source], []];

		await expect(
			requestRetranslation({ sourceType: 'post', sourceId: SRC, targetLang: 'ja' })
		).resolves.toEqual({ kind: 'not-found' });
	});

	it('creates a candidate when the draft was only prefilled by hand', async () => {
		// Copy prefill leaves no translation record, which is why the plain
		// generate path answers "already translated" and this one must not.
		state.selectQueue = [[source], [draftTarget], []];
		state.returningQueue = [[{ id: CANDIDATE }]];

		await expect(
			requestRetranslation({ sourceType: 'post', sourceId: SRC, targetLang: 'ja' })
		).resolves.toEqual({ kind: 'queued', id: CANDIDATE });

		expect(state.inserts[0]).toMatchObject({
			sourcePostId: SRC,
			targetLang: 'ja',
			origin: 'ai',
			status: 'draft',
			overwriteTarget: true
		});
		expect(enqueueJobMock).toHaveBeenCalledTimes(1);
	});

	it('resets the accepted record back to a pending run', async () => {
		state.selectQueue = [[source], [draftTarget], [{ id: CANDIDATE, status: 'accepted' }]];
		state.returningQueue = [[{ id: CANDIDATE }]];

		await expect(
			requestRetranslation({ sourceType: 'post', sourceId: SRC, targetLang: 'ja' })
		).resolves.toEqual({ kind: 'queued', id: CANDIDATE });

		// A new run may not inherit the previous lease, failure counters or body.
		expect(state.updates[0].values).toMatchObject({
			status: 'draft',
			content: null,
			error: null,
			attempt: 0,
			runs: 0,
			progress: null,
			overwriteTarget: true
		});
		expect(enqueueJobMock).toHaveBeenCalledTimes(1);
	});
});

describe('acceptTranslation overwrite permission', () => {
	const acceptedRow = (overwriteTarget: boolean) => ({
		id: CANDIDATE,
		sourcePostId: SRC,
		sourceNoteId: null,
		targetLang: 'ja',
		title: '訳文',
		content: '訳文の本文',
		summary: null,
		contentFormat: 'markdown',
		origin: 'ai',
		status: 'draft',
		sourceHash: null,
		targetPostId: null,
		targetNoteId: null,
		overwriteTarget
	});

	const queueAccept = (row: unknown) => {
		state.selectQueue = [
			[row], // the candidate for update
			[{ title: '源文', content: '源文正文', summary: null, contentFormat: 'markdown' }],
			[{ group: GROUP, categoryId: 'cat-1', slug: 'source-slug', topicId: SRC }],
			[
				{
					id: TARGET,
					status: 'draft',
					translatedFrom: SRC,
					lang: 'ja',
					slug: 'source-slug',
					version: 0,
					// No AI accept has written this draft yet.
					translationOrigin: null
				}
			],
			// The existing draft holds text the operator copied or wrote.
			[{ content: '人工译文' }],
			[{ id: 'draft-1', version: 3 }],
			[]
		];
		state.returningQueue = [[{ id: TARGET }]];
	};

	it('refuses to clobber an unmarked draft', async () => {
		queueAccept(acceptedRow(false));

		await expect(acceptTranslation(CANDIDATE, 'user-1')).resolves.toEqual({
			kind: 'target-draft-exists'
		});
		expect(state.updates).toEqual([]);
	});

	it('replaces the draft once the operator asked for a retranslation', async () => {
		queueAccept(acceptedRow(true));

		await expect(acceptTranslation(CANDIDATE, 'user-1')).resolves.toMatchObject({
			kind: 'accepted',
			targetId: TARGET
		});
		expect(state.updates[0].values).toMatchObject({ content: '訳文の本文' });
	});
});

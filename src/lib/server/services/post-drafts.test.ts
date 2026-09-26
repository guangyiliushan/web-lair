import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drafts, postRevisions, postTags, posts, tags } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';

/**
 * Service-level tests for the P2 draft flow (ledger §9.10 / §9.14.2-3):
 * autosave semantics (hash / throttle / optimistic lock), the publish
 * transaction (posts+drafts row locks, revision + slug tracker + tags + draft
 * removal, base check) and discard/createTranslation. The db module is mocked
 * with a small in-memory executor that records the table of every write, the
 * lock clauses and transaction usage - the assertions deliberately pin those
 * so removing a lock/transaction turns the suite red (mutation teeth, P2
 * review finding).
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		insertResults: [] as unknown[][],
		updateResults: [] as unknown[][],
		deleteResults: [] as unknown[][],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		forCalls: [] as unknown[],
		failWith: undefined as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import {
	DRAFT_THROTTLE_MS,
	createTranslationDraft,
	discardDraft,
	draftHash,
	draftsForPosts,
	isPlaceholderSlug,
	publishDraft,
	saveDraftWork,
	tempSlug
} from './post-drafts';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				// Record lock clauses so dropping .for('update') fails the suite.
				if (prop === 'for') {
					return (strength: unknown) => {
						state.forCalls.push(strength);
						return self;
					};
				}
				return () => self;
			}
		}
	);
	return self;
}

function makeExecutors() {
	return {
		select: vi.fn(() => makeChain(state.selectQueue.shift() ?? [])),
		insert: vi.fn((table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				state.inserts.push({ table, values });
				const settle = () => {
					if (state.failWith) throw state.failWith;
					return state.insertResults.shift() ?? [];
				};
				return {
					returning: async () => settle(),
					onConflictDoUpdate: () => ({ returning: async () => settle() }),
					onConflictDoNothing: async () => settle(),
					then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
						Promise.resolve(undefined).then(resolve, reject)
				};
			}
		})),
		update: vi.fn((table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					state.updates.push({ table, values });
					const settle = () => {
						if (state.failWith) throw state.failWith;
						return state.updateResults.shift() ?? [];
					};
					return {
						returning: async () => settle(),
						then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
							Promise.resolve(settle()).then(resolve, reject)
					};
				}
			})
		})),
		delete: vi.fn((table: unknown) => ({
			where: () => ({
				returning: async () => {
					if (state.failWith) throw state.failWith;
					state.deletes.push({ table });
					return state.deleteResults.shift() ?? [{ id: 'deleted' }];
				},
				then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
					if (state.failWith) return Promise.reject(state.failWith).catch(reject);
					state.deletes.push({ table });
					return Promise.resolve([]).then(resolve);
				}
			})
		}))
	};
}

const BASE_DRAFT = {
	id: 'draft-1',
	refType: 'post',
	refId: 'post-1',
	title: 'Old title',
	slug: 'old-slug',
	categoryId: 'cat-1',
	tags: ['t1'],
	content: 'Old content',
	contentFormat: 'markdown',
	summary: null,
	version: 3,
	baseVersion: 2,
	author: null,
	createdAt: new Date('2026-09-26T00:00:00Z'),
	updatedAt: new Date(Date.now() - 10 * 60 * 1000)
};

function payload(overrides: Record<string, string> = {}) {
	return {
		title: 'New title',
		slug: 'new-slug',
		categoryId: 'cat-1',
		summary: '',
		tags: 't1, t2',
		content: 'New content',
		...overrides
	};
}

function resetState(withTransaction = true) {
	state.selectQueue = [];
	state.insertResults = [];
	state.updateResults = [];
	state.deleteResults = [];
	state.updates = [];
	state.inserts = [];
	state.deletes = [];
	state.forCalls = [];
	state.failWith = undefined;
	const executors = makeExecutors();
	Object.assign(dbMock, {
		...executors,
		...(withTransaction
			? { transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors)) }
			: {})
	});
}

describe('post-drafts helpers', () => {
	it('mints placeholder slugs and recognises them', () => {
		expect(tempSlug()).toMatch(/^draft-[0-9a-f]{10}$/);
		expect(isPlaceholderSlug('draft-0123456789')).toBe(true);
		expect(isPlaceholderSlug('real-slug')).toBe(false);
	});

	it('hashes the payload stably and sensitively', () => {
		expect(draftHash(payload())).toBe(draftHash(payload()));
		expect(draftHash(payload())).not.toBe(draftHash(payload({ content: 'Other' })));
		expect(draftHash(payload({ tags: 't1,t2' }))).toBe(draftHash(payload({ tags: 't1, t2' })));
	});

	it('pins the throttle window (server-side contract)', () => {
		expect(DRAFT_THROTTLE_MS).toBe(30_000);
	});

	it('draftsForPosts short-circuits empty input and filters by ref id', async () => {
		resetState();
		await expect(draftsForPosts([])).resolves.toEqual(new Set());
		expect(dbMock.select).not.toHaveBeenCalled();

		state.selectQueue = [[{ refId: 'a' }, { refId: null }, { refId: 'b' }]];
		const found = await draftsForPosts(['a', 'b']);
		expect(found).toEqual(new Set(['a', 'b']));
	});
});

describe('saveDraftWork', () => {
	beforeEach(() => {
		resetState();
	});

	it('refuses a brand-new article without a category', async () => {
		const result = await saveDraftWork({
			draftId: null,
			postId: null,
			expectedVersion: null,
			lang: 'en',
			payload: payload({ categoryId: '' }),
			author: null,
			autosave: true
		});
		expect(result).toEqual({ kind: 'needs-category' });
		expect(state.inserts).toHaveLength(0);
	});

	it('creates a placeholder post plus the first draft for a new article', async () => {
		state.insertResults = [
			[{ id: 'post-9' }],
			[{ id: 'draft-9', version: 1, updatedAt: new Date('2026-09-26T10:00:00Z') }]
		];
		const result = await saveDraftWork({
			draftId: null,
			postId: null,
			expectedVersion: null,
			lang: 'zh-cn',
			payload: payload(),
			author: 'user-1',
			autosave: true
		});
		expect(result).toMatchObject({
			kind: 'saved',
			draftId: 'draft-9',
			postId: 'post-9',
			version: 1
		});
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
		expect(state.inserts[0].table).toBe(posts);
		expect(state.inserts[0].values).toMatchObject({
			lang: 'zh-cn',
			categoryId: 'cat-1',
			status: 'draft',
			version: 0
		});
		expect(String(state.inserts[0].values.slug)).toMatch(/^draft-/);
		expect(state.inserts[1].table).toBe(drafts);
		expect(state.inserts[1].values).toMatchObject({
			refType: 'post',
			refId: 'post-9',
			version: 1,
			baseVersion: 0,
			author: 'user-1',
			slug: 'new-slug',
			tags: ['t1', 't2']
		});
	});

	it('creates the first draft for an existing post with the posts version as base', async () => {
		state.selectQueue = [[], [{ id: 'post-1', version: 5 }]];
		state.insertResults = [[{ id: 'draft-1', version: 1, updatedAt: new Date() }]];
		const result = await saveDraftWork({
			draftId: null,
			postId: 'post-1',
			expectedVersion: null,
			payload: payload(),
			author: null,
			autosave: true
		});
		expect(result).toMatchObject({ kind: 'saved', draftId: 'draft-1', postId: 'post-1' });
		expect(state.inserts[0].table).toBe(drafts);
		expect(state.inserts[0].values).toMatchObject({ refId: 'post-1', baseVersion: 5 });
	});

	it('translates a concurrent draft creation (23505) into a conflict', async () => {
		state.selectQueue = [
			[], // loadDraftByPostId: none yet
			[{ id: 'post-1', version: 5 }],
			[{ ...BASE_DRAFT }] // the other tab's row, re-read in the catch
		];
		state.failWith = Object.assign(new Error('dup'), { cause: { code: '23505' } });
		const result = await saveDraftWork({
			draftId: null,
			postId: 'post-1',
			expectedVersion: null,
			payload: payload(),
			author: null,
			autosave: true
		});
		expect(result).toMatchObject({
			kind: 'conflict',
			server: { draftId: 'draft-1', version: 3 }
		});
	});

	it('skips identical payloads (hash 不变不写)', async () => {
		const draft = {
			...BASE_DRAFT,
			title: 'Same',
			slug: 'same-slug',
			categoryId: 'cat-1',
			tags: ['x'],
			content: 'Same body',
			summary: null
		};
		state.selectQueue = [[draft]];
		const result = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: draft.version,
			payload: {
				title: 'Same',
				slug: 'same-slug',
				categoryId: 'cat-1',
				summary: '',
				tags: 'x',
				content: 'Same body'
			},
			author: null,
			autosave: true
		});
		expect(result).toMatchObject({ kind: 'unchanged', version: 3 });
		expect(state.updates).toHaveLength(0);
	});

	it('throttles autosaves within the server window and lets manual saves through', async () => {
		const fresh = { ...BASE_DRAFT, updatedAt: new Date(), content: 'Current' };
		state.selectQueue = [[fresh]];
		const throttled = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: fresh.version,
			payload: payload({ content: 'Something else' }),
			author: null,
			autosave: true
		});
		expect(throttled).toMatchObject({
			kind: 'throttled',
			draftId: 'draft-1',
			version: 3,
			postId: 'post-1'
		});
		if (throttled.kind === 'throttled') {
			expect(throttled.retryAfterMs).toBeGreaterThan(0);
			expect(throttled.retryAfterMs).toBeLessThanOrEqual(DRAFT_THROTTLE_MS);
		}
		expect(state.updates).toHaveLength(0);

		state.selectQueue = [[fresh]];
		state.updateResults = [[{ id: 'draft-1', version: 4, updatedAt: new Date() }]];
		const manual = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: fresh.version,
			payload: payload({ content: 'Something else' }),
			author: null,
			autosave: false
		});
		expect(manual).toMatchObject({ kind: 'saved', version: 4 });
		expect(state.updates[0].values).toMatchObject({ version: 4, content: 'Something else' });
		// Saving must never touch the posts rows - only the working copy does.
		expect(state.updates.every((u) => u.table === drafts)).toBe(true);
	});

	it('lets the save through once the throttle window elapsed', async () => {
		const stale = { ...BASE_DRAFT, updatedAt: new Date(Date.now() - 31_000) };
		state.selectQueue = [[stale]];
		state.updateResults = [[{ id: 'draft-1', version: 4, updatedAt: new Date() }]];
		const result = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: stale.version,
			payload: payload({ content: 'After the window' }),
			author: null,
			autosave: true
		});
		expect(result).toMatchObject({ kind: 'saved', version: 4 });
	});

	it('answers a version conflict without writing', async () => {
		const draft = { ...BASE_DRAFT, version: 7 };
		state.selectQueue = [[draft]];
		const result = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: 3,
			payload: payload(),
			author: null,
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'conflict', server: { draftId: 'draft-1', version: 7 } });
		expect(state.updates).toHaveLength(0);
	});

	it('treats a vanished draft as a conflict', async () => {
		state.selectQueue = [[]];
		const result = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: 3,
			payload: payload(),
			author: null,
			autosave: true
		});
		expect(result).toEqual({
			kind: 'conflict',
			server: { draftId: null, version: 0, updatedAt: null }
		});
	});

	it('reports a lost conditional update as a conflict', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ ...BASE_DRAFT, version: 9 }]];
		state.updateResults = [[]];
		const result = await saveDraftWork({
			draftId: 'draft-1',
			postId: null,
			expectedVersion: 3,
			payload: payload(),
			author: null,
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'conflict', server: { version: 9 } });
	});
});

describe('publishDraft', () => {
	beforeEach(() => {
		resetState();
	});

	it('fails validation before any write (full message snapshot)', async () => {
		state.selectQueue = [
			[{ ...BASE_DRAFT, title: '  ', slug: null, content: null, categoryId: null }],
			[{ id: 'post-1', version: 2 }]
		];
		const result = await publishDraft('draft-1', 'user-1');
		expect(result).toEqual({
			kind: 'invalid',
			errors: {
				title: '标题不能为空',
				slug: 'Slug 不能为空',
				categoryId: '请选择分类',
				content: '正文不能为空'
			}
		});
		expect(dbMock.transaction).not.toHaveBeenCalled();
		expect(state.updates).toHaveLength(0);
	});

	it('rejects a malformed slug and the reserved draft- prefix', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, slug: 'Bad Slug' }], [{ id: 'post-1', version: 2 }]];
		const bad = await publishDraft('draft-1', null);
		expect(bad).toMatchObject({
			kind: 'invalid',
			errors: { slug: 'Slug 仅允许小写英文、数字和连字符' }
		});

		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'draft-abcdef1234' }],
			[{ id: 'post-1', version: 2 }]
		];
		const reserved = await publishDraft('draft-1', null);
		expect(reserved).toMatchObject({
			kind: 'invalid',
			errors: { slug: '该 Slug 前缀由系统占位保留，请更换' }
		});
	});

	it('publishes the freshly locked rows: revision, tracker, tags, draft removal', async () => {
		const draft = { ...BASE_DRAFT, slug: 'new-slug', baseVersion: 2 };
		state.selectQueue = [
			[draft], // loadDraftById (outer snapshot)
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }], // posts lookup
			[{ id: 'cat-1' }], // category check
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }], // locked posts row
			[{ ...draft, content: 'Locked newest' }] // locked draft row (in-tx re-read)
		];
		state.insertResults = [[{ id: 't1' }], []]; // tags upsert, postTags insert
		const result = await publishDraft('draft-1', 'user-1');
		expect(result).toEqual({ kind: 'published', postId: 'post-1', version: 3 });
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
		// Both rows are locked, in the posts → drafts order (deadlock avoidance).
		expect(state.forCalls).toEqual(['update', 'update']);
		expect(state.selectQueue).toHaveLength(0);

		const tracker = state.inserts.find((i) => i.table === slugTrackers);
		expect(tracker?.values).toEqual({
			slug: 'old-slug',
			type: 'post',
			lang: 'en',
			targetId: 'post-1'
		});

		const postUpdate = state.updates.find((u) => u.table === posts);
		expect(postUpdate?.values).toMatchObject({
			title: 'Old title',
			slug: 'new-slug',
			status: 'published',
			version: 3,
			// Content comes from the row locked inside the transaction, not the
			// outer snapshot (lost-update guard).
			content: 'Locked newest',
			contentFormat: 'markdown',
			summary: null
		});

		const tagUpsert = state.inserts.find((i) => i.table === tags);
		expect(tagUpsert?.values).toEqual({ name: 't1', slug: 't1' });
		const junction = state.inserts.find((i) => i.table === postTags);
		expect(junction?.values).toEqual({ postId: 'post-1', tagId: 't1' });

		const revision = state.inserts.find((i) => i.table === postRevisions);
		expect(revision?.values).toMatchObject({
			postId: 'post-1',
			version: 3,
			source: 'publish',
			author: 'user-1',
			content: 'Locked newest'
		});

		expect(state.deletes.some((d) => d.table === drafts)).toBe(true);
		expect(state.deletes.some((d) => d.table === postTags)).toBe(true);
	});

	it('publishes a user slug that keeps the same name (no tracker)', async () => {
		const draft = { ...BASE_DRAFT, slug: 'old-slug', baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'zh-cn' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'zh-cn' }],
			[{ ...draft }]
		];
		state.insertResults = [[{ id: 't1' }], []];
		await publishDraft('draft-1', null);
		expect(state.inserts.find((i) => i.table === slugTrackers)).toBeUndefined();
		// Lang comes from the locked posts row, not a literal.
		expect(state.forCalls).toEqual(['update', 'update']);
	});

	it('does not record a tracker for placeholder slugs', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 0 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 0, slug: 'draft-aaaaaaaaaa', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 0, slug: 'draft-aaaaaaaaaa', lang: 'en' }],
			[{ ...draft }]
		];
		state.insertResults = [[{ id: 't1' }], []];
		await publishDraft('draft-1', null);
		expect(state.inserts.find((i) => i.table === slugTrackers)).toBeUndefined();
	});

	it('stops on a base-version mismatch (another tab published)', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 4, slug: 'old-slug', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 4, slug: 'old-slug', lang: 'en' }],
			[{ ...draft }]
		];
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'conflict', server: { version: 4 } });
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('stops when the working copy vanished inside the transaction', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[] // the draft row is gone (published/discarded concurrently)
		];
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.updates).toHaveLength(0);
	});

	it('translates a 23505 race into slug-taken', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ ...draft }]
		];
		state.failWith = Object.assign(new Error('dup'), { cause: { code: '23505' } });
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'slug-taken' });
	});

	it('reports a deadlock as busy (40P01)', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ ...draft }]
		];
		state.failWith = Object.assign(new Error('deadlock'), { cause: { code: '40P01' } });
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'busy' });
	});
});

describe('discardDraft', () => {
	beforeEach(() => {
		resetState();
	});

	it('removes a never-published placeholder together with its draft', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'draft', version: 0 }]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'discarded', postId: 'post-1', removedPlaceholder: true });
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
		// The seed row is locked before the working copy is removed.
		expect(state.forCalls).toEqual(['update']);
		expect(state.deletes.map((d) => d.table)).toEqual([drafts, posts]);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('keeps a published post when only its working copy is discarded', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'published', version: 4 }]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'discarded', postId: 'post-1', removedPlaceholder: false });
		expect(state.deletes.map((d) => d.table)).toEqual([drafts]);
	});

	it('answers not-found when the draft vanished before the delete', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'published', version: 4 }]];
		state.deleteResults = [[]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.deletes.map((d) => d.table)).toEqual([drafts]);
	});

	it('answers plain not-found when the draft does not exist', async () => {
		state.selectQueue = [[]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.deletes).toHaveLength(0);
	});

	it('reports a deadlock as busy (40P01)', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'published', version: 4 }]];
		state.failWith = Object.assign(new Error('deadlock'), { cause: { code: '40P01' } });
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'busy' });
	});
});

describe('createTranslationDraft', () => {
	beforeEach(() => {
		resetState();
	});

	it('rejects the same language, chained translations and existing siblings', async () => {
		state.selectQueue = [[{ id: 'post-1', lang: 'en' }]];
		expect((await createTranslationDraft('post-1', 'en', null)).kind).toBe('same-lang');

		state.selectQueue = [[{ id: 'post-1', lang: 'zh-cn', translatedFromPostId: 'post-9' }]];
		expect((await createTranslationDraft('post-1', 'ja', null)).kind).toBe('not-source');

		state.selectQueue = [[{ id: 'post-1', lang: 'en' }], [{ id: 'post-2' }]];
		expect((await createTranslationDraft('post-1', 'zh-cn', null)).kind).toBe('lang-exists');
	});

	it('translates a concurrent duplicate (23505) into lang-exists', async () => {
		state.selectQueue = [
			[{ id: 'post-1', lang: 'en', translatedFromPostId: null, translationGroup: 'group-1' }],
			[]
		];
		state.failWith = Object.assign(new Error('dup'), { cause: { code: '23505' } });
		const result = await createTranslationDraft('post-1', 'zh-cn', null);
		expect(result).toEqual({ kind: 'lang-exists' });
	});

	it('copies the prefill into the new draft (§9.20.4)', async () => {
		state.selectQueue = [
			[
				{
					id: 'post-1',
					lang: 'en',
					title: 'Source title',
					content: 'Source body',
					summary: 'Source summary',
					contentFormat: 'markdown',
					categoryId: 'cat-1',
					translationGroup: 'group-1',
					translatedFromPostId: null
				}
			],
			[]
		];
		state.insertResults = [[{ id: 'post-9' }], []];
		const result = await createTranslationDraft('post-1', 'zh-cn', 'user-1');
		expect(result).toEqual({ kind: 'created', postId: 'post-9' });
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);

		const created = state.inserts.find((i) => i.table === posts);
		expect(created?.values).toMatchObject({
			lang: 'zh-cn',
			translationGroup: 'group-1',
			translatedFromPostId: 'post-1',
			categoryId: 'cat-1',
			status: 'draft'
		});
		const prefill = state.inserts.find((i) => i.table === drafts);
		expect(prefill?.values).toMatchObject({
			refId: 'post-9',
			title: 'Source title',
			content: 'Source body',
			summary: 'Source summary',
			slug: null
		});
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drafts, postRevisions, postTags, posts } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';

/**
 * Service-level tests for the P2 draft flow (ledger §9.10 / §9.14.2-3):
 * autosave semantics (hash / throttle / optimistic lock), the publish
 * transaction (revision + slug tracker + tags + draft removal, base check)
 * and discard/createTranslation. The db module is mocked with a small
 * in-memory executor; schema objects are real so tables can be told apart.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		insertResults: [] as unknown[][],
		updateResults: [] as unknown[][],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
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
					state.deletes.push({ table });
					return [];
				},
				then: (resolve: (value: unknown) => unknown) => {
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
});

describe('saveDraftWork', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.insertResults = [];
		state.updateResults = [];
		state.updates = [];
		state.inserts = [];
		state.deletes = [];
		state.failWith = undefined;
		const executors = makeExecutors();
		Object.assign(dbMock, {
			...executors,
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors))
		});
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

	it('throttles autosaves within the server window but lets manual saves through', async () => {
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
		expect(throttled).toEqual({
			kind: 'throttled',
			draftId: 'draft-1',
			version: 3,
			postId: 'post-1'
		});
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
		state.selectQueue = [];
		state.insertResults = [];
		state.updateResults = [];
		state.updates = [];
		state.inserts = [];
		state.deletes = [];
		state.failWith = undefined;
		const executors = makeExecutors();
		Object.assign(dbMock, {
			...executors,
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors))
		});
	});

	it('fails validation before any write', async () => {
		state.selectQueue = [
			[{ ...BASE_DRAFT, title: '  ', slug: null, content: null }],
			[{ id: 'post-1', version: 2 }]
		];
		const result = await publishDraft('draft-1', 'user-1');
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') {
			expect(result.errors).toMatchObject({
				title: expect.any(String),
				slug: expect.any(String),
				content: expect.any(String)
			});
		}
		expect(state.updates).toHaveLength(0);
	});

	it('publishes inside one transaction: revision, tracker, tags, draft removal', async () => {
		const draft = { ...BASE_DRAFT, slug: 'new-slug', baseVersion: 2 };
		state.selectQueue = [
			[draft], // loadDraftById
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }], // posts lookup
			[{ id: 'cat-1' }], // category check
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }] // locked row
		];
		state.insertResults = [[{ id: 't1' }], []]; // tags upsert, postTags insert
		const result = await publishDraft('draft-1', 'user-1');
		expect(result).toEqual({ kind: 'published', postId: 'post-1', version: 3 });

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
			version: 3
		});

		const revision = state.inserts.find((i) => i.table === postRevisions);
		expect(revision?.values).toMatchObject({
			postId: 'post-1',
			version: 3,
			source: 'publish',
			author: 'user-1'
		});

		expect(state.deletes.some((d) => d.table === drafts)).toBe(true);
		expect(state.deletes.some((d) => d.table === postTags)).toBe(true);
	});

	it('does not record a tracker for placeholder slugs', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 0 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 0, slug: 'draft-aaaaaaaaaa', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 0, slug: 'draft-aaaaaaaaaa', lang: 'en' }]
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
			[{ id: 'post-1', version: 4, slug: 'old-slug', lang: 'en' }]
		];
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'conflict', server: { version: 4 } });
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('translates a 23505 race into slug-taken', async () => {
		const draft = { ...BASE_DRAFT, baseVersion: 2 };
		state.selectQueue = [
			[draft],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }],
			[{ id: 'cat-1' }],
			[{ id: 'post-1', version: 2, slug: 'old-slug', lang: 'en' }]
		];
		state.failWith = Object.assign(new Error('dup'), { cause: { code: '23505' } });
		const result = await publishDraft('draft-1', null);
		expect(result).toEqual({ kind: 'slug-taken' });
	});
});

describe('discardDraft', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.insertResults = [];
		state.updates = [];
		state.inserts = [];
		state.deletes = [];
		state.failWith = undefined;
		const executors = makeExecutors();
		Object.assign(dbMock, {
			...executors,
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors))
		});
	});

	it('removes a never-published placeholder together with its draft', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'draft', version: 0 }]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'discarded', postId: 'post-1', removedPlaceholder: true });
		expect(state.deletes.map((d) => d.table)).toEqual([drafts, posts]);
	});

	it('keeps a published post when only its working copy is discarded', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT }], [{ id: 'post-1', status: 'published', version: 4 }]];
		const result = await discardDraft('draft-1');
		expect(result).toEqual({ kind: 'discarded', postId: 'post-1', removedPlaceholder: false });
		expect(state.deletes.map((d) => d.table)).toEqual([drafts]);
	});
});

describe('createTranslationDraft', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.insertResults = [];
		state.updates = [];
		state.inserts = [];
		state.deletes = [];
		state.failWith = undefined;
		const executors = makeExecutors();
		Object.assign(dbMock, {
			...executors,
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors))
		});
	});

	it('rejects the same language and existing siblings', async () => {
		state.selectQueue = [[{ id: 'post-1', lang: 'en' }]];
		expect((await createTranslationDraft('post-1', 'en', null)).kind).toBe('same-lang');

		state.selectQueue = [[{ id: 'post-1', lang: 'en' }], [{ id: 'post-2' }]];
		expect((await createTranslationDraft('post-1', 'zh-cn', null)).kind).toBe('lang-exists');
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
					translationGroup: 'group-1'
				}
			],
			[]
		];
		state.insertResults = [[{ id: 'post-9' }], []];
		const result = await createTranslationDraft('post-1', 'zh-cn', 'user-1');
		expect(result).toEqual({ kind: 'created', postId: 'post-9' });

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

// DRAFT_THROTTLE_MS is part of the public contract (client retry timing).
void DRAFT_THROTTLE_MS;

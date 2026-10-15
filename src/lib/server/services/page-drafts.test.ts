import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// The copy resolves from the catalog at call time; pin the locale so the
// assertions stay in sync with the zh-cn catalog (same convention as
// maintenance-form-utils.test.ts).
overwriteGetLocale(() => 'zh-cn');
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { drafts, pages } from '$lib/server/db/content';
import type { PageDraftPayload } from '$lib/server/db/content';

/**
 * Service-level tests for the pages draft flow (pages line P5-1; ledger
 * §19.10): autosave semantics (hash / throttle / optimistic lock), the
 * publish transaction (pages+drafts row locks, the conditional first-publish
 * status flip, draft removal - and the W1 divergence of NO slug tracker) and
 * the discard contract (placeholder removal by `content is null`). The db
 * module is mocked with the same executor recorder as note-drafts.test.ts -
 * removing a lock / transaction / condition turns the suite red.
 */
const { dbMock, state, syncMock } = vi.hoisted(() => ({
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
		selectWheres: [] as unknown[],
		updateWheres: [] as unknown[],
		transactions: 0,
		failWith: undefined as unknown,
		txExecutors: null as unknown
	},
	syncMock: vi.fn(async () => {})
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
// The reference diff runs in the content transaction; its own teeth live in
// file-references.test.ts. Here we pin WHERE it is called from and with which
// target/keys (plus the Q6 no-op autosave short-circuit).
vi.mock('./file-references', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./file-references')>();
	return { ...actual, syncFileReferences: syncMock };
});

import {
	discardPageDraft,
	draftsForPages,
	isPagePlaceholderSlug,
	pageDraftHash,
	publishPageDraft,
	savePageDraftWork
} from './page-drafts';

const dialect = new PgDialect();
const render = (expression: unknown) => dialect.sqlToQuery(expression as SQL);

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
				if (prop === 'where') {
					return (...args: unknown[]) => {
						state.selectWheres.push(args[0]);
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
				where: (...whereArgs: unknown[]) => {
					state.updates.push({ table, values });
					state.updateWheres.push(whereArgs[0]);
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

const PAGE_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '22222222-2222-2222-2222-222222222222';

const BASE_DRAFT = {
	id: DRAFT_ID,
	refType: 'page',
	refId: PAGE_ID,
	slug: 'old-slug',
	payload: {
		title: { en: 'Old title', 'zh-cn': '旧标题' },
		description: { en: 'Old description' },
		content: { en: 'Old content' }
	},
	contentFormat: 'markdown',
	version: 3,
	baseVersion: null,
	author: null,
	updatedAt: new Date('2026-10-02T12:00:00Z')
};

function payloadFromRow(row: typeof BASE_DRAFT): PageDraftPayload {
	return {
		title: row.payload.title,
		description: row.payload.description,
		content: row.payload.content
	};
}

describe('page draft flow', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.insertResults = [];
		state.updateResults = [];
		state.deleteResults = [];
		state.updates = [];
		state.deletes = [];
		state.inserts = [];
		state.forCalls = [];
		state.selectWheres = [];
		state.updateWheres = [];
		state.transactions = 0;
		state.failWith = undefined;
		syncMock.mockClear();
		Object.assign(dbMock, {
			...makeExecutors(),
			transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
				state.transactions += 1;
				// Store the executor so tests can pin that sync ran on the
				// TRANSACTION, not the bare db (Q15's strongest contract).
				state.txExecutors = makeExecutors();
				return callback(state.txExecutors);
			})
		});
	});

	it('hashes every member of the write set (a dropped locale cannot stay invisible)', () => {
		// Each variant differs in exactly ONE write-set member; if a member
		// fell out of pageDraftUpdateSet the hash would stop discriminating
		// it and an edit would silently return `unchanged`.
		const base = payloadFromRow(BASE_DRAFT);
		const baseHash = pageDraftHash(BASE_DRAFT.slug, base);
		expect(pageDraftHash(BASE_DRAFT.slug, payloadFromRow(BASE_DRAFT))).toBe(baseHash);
		// The slug rides the shared drafts column but is still part of the basis.
		expect(pageDraftHash('other-slug', base)).not.toBe(baseHash);
		const variants: Record<string, unknown>[] = [
			{ title: { en: 'New title' } },
			{ title: { en: 'Old title', 'zh-cn': '旧标题', ja: '古いタイトル' } },
			{ description: { en: 'Other description' } },
			{ description: null },
			{ content: { en: 'New content' } },
			{ content: { en: 'Old content', ja: '本文' } }
		];
		for (const variant of variants) {
			expect(
				pageDraftHash(BASE_DRAFT.slug, { ...base, ...variant } as PageDraftPayload),
				JSON.stringify(variant)
			).not.toBe(baseHash);
		}
		// Canonical shape: an empty-string locale drops and never fakes a
		// change (the map stays otherwise identical).
		expect(
			pageDraftHash(BASE_DRAFT.slug, {
				...base,
				title: { ...BASE_DRAFT.payload.title, ja: '' }
			})
		).toBe(baseHash);
	});

	it('normalizes CRLF / lone-CR bodies to LF at the service entry (3b1 05-P3-6)', async () => {
		expect(
			pageDraftHash('s', { title: {}, description: null, content: { en: 'one\r\ntwo\r' } })
		).toBe(pageDraftHash('s', { title: {}, description: null, content: { en: 'one\ntwo\n' } }));

		state.selectQueue = [[], [{ id: PAGE_ID, content: { en: 'x' }, slug: 'live-slug' }]];
		state.insertResults = [[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]];
		await savePageDraftWork({
			pageId: PAGE_ID,
			slug: '',
			payload: { title: {}, description: null, content: { en: 'one\r\ntwo\r' } },
			autosave: false
		});
		const insert = state.inserts.find((entry) => entry.table === drafts);
		const stored = insert?.values.payload as { content: Record<string, string> };
		expect(stored.content).toEqual({ en: 'one\ntwo\n' });
	});

	it('answers unchanged when the payload equals the stored draft', async () => {
		state.selectQueue = [[BASE_DRAFT], [{ id: PAGE_ID }]];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: payloadFromRow(BASE_DRAFT),
			autosave: true
		});
		expect(result).toMatchObject({ kind: 'unchanged', version: 3, pageId: PAGE_ID });
		expect(state.updates).toHaveLength(0);
		// Q6 short-circuit: identical payloads never reach the reference scan.
		expect(syncMock).not.toHaveBeenCalled();
	});

	it('throttles autosave but lets a manual save through; the window expires', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }], [{ id: PAGE_ID }]];
		const throttled = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'New title' } },
			autosave: true
		});
		expect(throttled.kind).toBe('throttled');
		if (throttled.kind === 'throttled') expect(throttled.retryAfterMs).toBeGreaterThan(0);
		expect(state.updates).toHaveLength(0);

		// Past the 30s window an autosave is allowed again.
		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date(Date.now() - 31_000) }], [{ id: PAGE_ID }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
		const afterWindow = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'New title' } },
			autosave: true
		});
		expect(afterWindow.kind).toBe('saved');

		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }], [{ id: PAGE_ID }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 5, updatedAt: new Date() }]];
		const manual = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'New title' } },
			autosave: false
		});
		expect(manual).toMatchObject({ kind: 'saved', version: 5 });
		expect(state.updates).toHaveLength(2);
	});

	it('refuses a stale optimistic version with the server state attached', async () => {
		state.selectQueue = [[BASE_DRAFT], [{ id: PAGE_ID }]];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			expectedVersion: 2,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), content: { en: 'Changed' } },
			autosave: false
		});
		expect(result).toMatchObject({
			kind: 'conflict',
			server: { draftId: DRAFT_ID, version: 3 }
		});
		expect(state.updates).toHaveLength(0);
	});

	it('detects a lost conditional update (concurrent save) as a conflict', async () => {
		state.selectQueue = [[BASE_DRAFT], [{ id: PAGE_ID }], [BASE_DRAFT]];
		state.updateResults = [[]];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'New title' } },
			autosave: false
		});
		expect(result.kind).toBe('conflict');
		expect(state.updates).toHaveLength(1);
		// The conditional update must be pinned to the version we read.
		const rendered = render(state.updateWheres[0]);
		expect(rendered.sql).toContain('"drafts"."version" =');
		expect(rendered.params).toContain(3);
		// The conditional update lost: the loser must not touch references.
		expect(syncMock).not.toHaveBeenCalled();
	});

	it('syncs the page draft-identity references inside the save transaction (Q6/Q15)', async () => {
		const KEY_EN = `ab/${'a'.repeat(64)}.png`;
		const KEY_JA = `cd/${'b'.repeat(64)}.jpg`;
		state.selectQueue = [[BASE_DRAFT], [{ id: PAGE_ID }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: {
				...payloadFromRow(BASE_DRAFT),
				content: { en: `body /i/${KEY_EN}@preview tail`, ja: `本文 /i/${KEY_JA}` }
			},
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 4 });
		expect(syncMock).toHaveBeenCalledTimes(1);
		const call = syncMock.mock.calls[0] as unknown as [
			unknown,
			{ type: string; id: string },
			string[]
		];
		expect(call[0]).toBe(state.txExecutors);
		expect(call[1]).toEqual({ type: 'draft', id: DRAFT_ID });
		// Keys union over locales in canonical locale order (en before ja).
		expect(call[2]).toEqual([KEY_EN, KEY_JA]);
	});

	it('creates a draft row for an existing page without one', async () => {
		state.selectQueue = [[], [{ id: PAGE_ID, content: { en: 'x' }, slug: 'live-slug' }]];
		state.insertResults = [[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]];
		const result = await savePageDraftWork({
			pageId: PAGE_ID,
			slug: '',
			payload: { ...payloadFromRow(BASE_DRAFT), title: {} },
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 1, pageId: PAGE_ID });
		const insert = state.inserts.find((entry) => entry.table === drafts);
		expect(insert?.values).toMatchObject({
			refType: 'page',
			refId: PAGE_ID,
			version: 1,
			baseVersion: null
		});
		// Empty slug folds to null on the shared column.
		expect(insert?.values.slug).toBeNull();
		// The draft lookup is scoped to the page refType.
		const rendered = render(state.selectWheres[0]);
		expect(rendered.sql).toContain('"drafts"."ref_type"');
		expect(rendered.params).toContain('page');
		// Attaching to published content syncs the submitted body's refs too
		// (draft identity, 3b2: the page's own set is untouched here).
		expect(syncMock).toHaveBeenCalledWith(state.txExecutors, { type: 'draft', id: DRAFT_ID }, []);
		expect((syncMock.mock.calls[0] as unknown[])[0]).toBe(state.txExecutors);
	});

	it('maps a concurrent draft creation (23505) to a conflict', async () => {
		state.selectQueue = [
			[],
			[{ id: PAGE_ID, content: { en: 'x' }, slug: 'live-slug' }],
			[{ ...BASE_DRAFT, version: 5 }]
		];
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		const result = await savePageDraftWork({
			pageId: PAGE_ID,
			slug: 'x-slug',
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'conflict', server: { version: 5 } });
	});

	it('materializes a placeholder page + draft for a brand-new page (no precondition)', async () => {
		state.insertResults = [
			[{ id: PAGE_ID }],
			[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]
		];
		const result = await savePageDraftWork({
			slug: 'fresh-slug',
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'First' } },
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 1, pageId: PAGE_ID });
		expect(state.transactions).toBe(1);
		const pageInsert = state.inserts.find((entry) => entry.table === pages);
		expect(pageInsert?.values).toMatchObject({
			status: 'hidden',
			contentFormat: 'markdown',
			title: { en: 'First' }
		});
		expect(isPagePlaceholderSlug(String(pageInsert?.values.slug))).toBe(true);
		const draftInsert = state.inserts.find((entry) => entry.table === drafts);
		expect(draftInsert?.values).toMatchObject({
			refType: 'page',
			refId: PAGE_ID,
			slug: 'fresh-slug'
		});
		// References ride the materialization transaction under the draft's
		// own identity (3b2).
		expect(syncMock).toHaveBeenCalledWith(state.txExecutors, { type: 'draft', id: DRAFT_ID }, []);
	});

	it('retries the placeholder slug three times and rethrows the last collision', async () => {
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		await expect(
			savePageDraftWork({ slug: '', payload: payloadFromRow(BASE_DRAFT), autosave: false })
		).rejects.toThrow('dup');
		expect(state.transactions).toBe(3);
	});

	it('publishes the locked draft: field copy, first-publish visible, no tracker', async () => {
		const KEY = `ab/${'a'.repeat(64)}.png`;
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'fresh-slug' }],
			[{ id: PAGE_ID, slug: 'draft-abc123', content: null, isDefault: false }],
			[{ id: PAGE_ID, slug: 'draft-abc123', content: null, isDefault: false }],
			[
				{
					...BASE_DRAFT,
					slug: 'fresh-slug',
					payload: { ...BASE_DRAFT.payload, content: { en: `body /i/${KEY}@full tail` } }
				}
			]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toMatchObject({ kind: 'published', pageId: PAGE_ID });
		expect(state.transactions).toBe(1);
		// Both rows locked, pages first (deadlock-free order).
		expect(state.forCalls).toHaveLength(2);
		const pageUpdate = state.updates.find((entry) => entry.table === pages);
		// Every payload member is copied onto the row - dropping any single
		// one must fail here.
		expect(pageUpdate?.values).toMatchObject({
			slug: 'fresh-slug',
			title: { en: 'Old title', 'zh-cn': '旧标题' },
			description: { en: 'Old description' },
			content: { en: `body /i/${KEY}@full tail` },
			contentFormat: 'markdown',
			status: 'visible'
		});
		expect(state.deletes.some((entry) => entry.table === drafts)).toBe(true);
		// W1 divergence 4: pages write no slug tracker - zero inserts at all.
		expect(state.inserts).toHaveLength(0);
		expect(syncMock).toHaveBeenCalledTimes(2);
		expect(syncMock).toHaveBeenNthCalledWith(
			1,
			state.txExecutors,
			{ type: 'page', id: PAGE_ID },
			[KEY]
		);
		expect((syncMock.mock.calls[0] as unknown[])[0]).toBe(state.txExecutors);
		// The draft's own refs leave with the draft row (3b2) as a full
		// clear, after the durable page set (sync-then-clear order).
		expect(syncMock).toHaveBeenNthCalledWith(
			2,
			state.txExecutors,
			{ type: 'draft', id: DRAFT_ID },
			[]
		);
		expect(syncMock.mock.invocationCallOrder[0]).toBeLessThan(
			syncMock.mock.invocationCallOrder[1]
		);
	});

	it('keeps the status of an ever-published row on re-publish (conditional flip)', async () => {
		const lockedPage = {
			id: PAGE_ID,
			slug: 'live-slug',
			content: { en: 'old body' },
			isDefault: false
		};
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'live-slug' }],
			[lockedPage],
			[lockedPage],
			[{ ...BASE_DRAFT, slug: 'live-slug' }]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toMatchObject({ kind: 'published', pageId: PAGE_ID });
		const pageUpdate = state.updates.find((entry) => entry.table === pages);
		expect(pageUpdate?.values.slug).toBe('live-slug');
		// No status key at all: the ruling preserves whatever the row carries
		// (visible or deliberately hidden).
		expect(pageUpdate?.values.status).toBeUndefined();
	});

	it('publishes a default row in place when the slug is unchanged', async () => {
		const lockedPage = {
			id: PAGE_ID,
			slug: 'about',
			content: { en: 'old' },
			isDefault: true
		};
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'about' }],
			[lockedPage],
			[lockedPage],
			[{ ...BASE_DRAFT, slug: 'about' }]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toMatchObject({ kind: 'published', pageId: PAGE_ID });
		expect(state.updates.find((entry) => entry.table === pages)?.values.status).toBeUndefined();
	});

	it('refuses a slug change on a default row (seed anchors stay locked)', async () => {
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'about-renamed' }],
			[{ id: PAGE_ID, slug: 'about', content: { en: 'x' }, isDefault: true }]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') expect(result.errors.slug).toContain('不可修改');
		expect(state.transactions).toBe(0);
	});

	it('rejects invalid publish payloads branch by branch before any transaction', async () => {
		const cases: { payload: Partial<PageDraftPayload>; slug?: string; key: string; match?: string }[] =
			[
				{ payload: { title: { en: '   ' } }, key: 'title', match: '语言' },
				{ payload: {}, slug: '', key: 'slug', match: '不能为空' },
				{ payload: {}, slug: 'Hello', key: 'slug', match: '小写' },
				{ payload: {}, slug: 'admin', key: 'slug', match: '保留词' },
				{ payload: {}, slug: 'draft-taken', key: 'slug', match: '占位' },
				{ payload: { content: { ja: '  ' } }, key: 'content', match: '正文' }
			];
		for (const testCase of cases) {
			const draft = {
				...BASE_DRAFT,
				slug: testCase.slug !== undefined ? testCase.slug : BASE_DRAFT.slug,
				payload: { ...BASE_DRAFT.payload, ...testCase.payload }
			};
			state.selectQueue = [
				[draft],
				[{ id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false }]
			];
			const result = await publishPageDraft(DRAFT_ID);
			expect(result.kind, JSON.stringify(testCase)).toBe('invalid');
			if (result.kind === 'invalid') {
				expect(result.errors[testCase.key], JSON.stringify(testCase)).toBeTruthy();
				if (testCase.match) expect(result.errors[testCase.key]).toContain(testCase.match);
			}
		}
		expect(state.transactions).toBe(0);
	});

	it('re-checks the locked draft inside the transaction (changed under us)', async () => {
		const livePage = { id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false };
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'ok-slug' }],
			[livePage],
			[livePage],
			[{ ...BASE_DRAFT, slug: 'ok-slug', payload: { ...BASE_DRAFT.payload, title: {} } }]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') expect(result.errors.form).toContain('变化');
	});

	it('maps a unique violation at publish to slug-taken', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT]];
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'slug-taken' });
	});

	it('maps deadlock/serialization failures at publish and discard to busy', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT]];
		state.failWith = Object.assign(new Error('deadlock'), { code: '40P01' });
		expect(await publishPageDraft(DRAFT_ID)).toEqual({ kind: 'busy' });

		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false }]
		];
		state.failWith = Object.assign(new Error('serialization'), { code: '40001' });
		expect(await discardPageDraft(DRAFT_ID)).toEqual({ kind: 'busy' });
	});

	it('answers not-found when the publish target is missing (refId null or row gone)', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, refId: null }]];
		expect(await publishPageDraft(DRAFT_ID)).toEqual({ kind: 'not-found' });

		state.selectQueue = [[BASE_DRAFT], []];
		expect(await publishPageDraft(DRAFT_ID)).toEqual({ kind: 'not-found' });
	});

	it('discards a never-published placeholder page together with its draft', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: PAGE_ID, slug: 'draft-abc123', content: null, isDefault: false }]
		];
		state.deleteResults = [[{ id: DRAFT_ID }], []];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: PAGE_ID, removedPlaceholder: true });
		expect(state.transactions).toBe(1);
		// The page row is locked first (same order as publish).
		expect(state.forCalls).toEqual(['update']);
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts, pages]);
		expect(syncMock).toHaveBeenCalledTimes(2);
		expect(syncMock).toHaveBeenNthCalledWith(
			1,
			state.txExecutors,
			{ type: 'page', id: PAGE_ID },
			[]
		);
		expect((syncMock.mock.calls[0] as unknown[])[0]).toBe(state.txExecutors);
		expect(syncMock).toHaveBeenNthCalledWith(
			2,
			state.txExecutors,
			{ type: 'draft', id: DRAFT_ID },
			[]
		);
	});

	it('keeps an ever-published row (content decides) and restores its references', async () => {
		const KEY = `ab/${'a'.repeat(64)}.png`;
		state.selectQueue = [
			[BASE_DRAFT],
			[
				{
					id: PAGE_ID,
					slug: 'live-slug',
					content: { en: `live /i/${KEY} body` },
					isDefault: false
				}
			]
		];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: PAGE_ID, removedPlaceholder: false });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts]);
		expect(syncMock).toHaveBeenCalledTimes(2);
		expect(syncMock).toHaveBeenNthCalledWith(
			1,
			state.txExecutors,
			{ type: 'page', id: PAGE_ID },
			[KEY]
		);
		// The draft's own refs leave with its row (3b2) as a full clear.
		expect(syncMock).toHaveBeenNthCalledWith(
			2,
			state.txExecutors,
			{ type: 'draft', id: DRAFT_ID },
			[]
		);
	});

	it('answers not-found when the draft vanished before the delete', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false }]
		];
		state.deleteResults = [[]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts]);
		expect(syncMock).not.toHaveBeenCalled();
	});

	it('discards a draft that never carried a target (refId null) and clears its refs', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, refId: null }]];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: null, removedPlaceholder: false });
		expect(syncMock).toHaveBeenCalledTimes(1);
		expect(syncMock).toHaveBeenCalledWith(state.txExecutors, { type: 'draft', id: DRAFT_ID }, []);
	});

	it('answers plain not-found when the draft does not exist', async () => {
		state.selectQueue = [[]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.deletes).toHaveLength(0);
		expect(syncMock).not.toHaveBeenCalled();
	});

	it('reports the pages that carry a pending draft (empty input short-circuits)', async () => {
		state.selectQueue = [[{ refId: PAGE_ID }, { refId: null }]];
		const set = await draftsForPages([PAGE_ID]);
		expect(set).toEqual(new Set([PAGE_ID]));

		const selectSpy = dbMock.select as ReturnType<typeof vi.fn>;
		selectSpy.mockClear();
		expect(await draftsForPages([])).toEqual(new Set());
		expect(selectSpy).not.toHaveBeenCalled();
	});

	/* ── P5-5a review teeth (T1-T5 + M1/M3) ─────────────────────────────── */

	it('answers a null-draftId conflict when the draft row vanished (T1)', async () => {
		state.selectQueue = [[]];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: 'x',
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		expect(result).toEqual({
			kind: 'conflict',
			server: { draftId: null, version: 0, updatedAt: null }
		});
	});

	it('answers not-found when the target page vanished before a write (M1 belt)', async () => {
		state.selectQueue = [[BASE_DRAFT], []];
		const result = await savePageDraftWork({
			draftId: DRAFT_ID,
			slug: BASE_DRAFT.slug,
			payload: { ...payloadFromRow(BASE_DRAFT), title: { en: 'Changed' } },
			autosave: false
		});
		expect(result).toEqual({ kind: 'not-found' });
	});

	it('refuses to attach a draft to a non-editor row (code/external, M3)', async () => {
		state.selectQueue = [[], [{ id: PAGE_ID, content: null, slug: 'live-slug' }]];
		const result = await savePageDraftWork({
			pageId: PAGE_ID,
			slug: 'x',
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		expect(result).toEqual({ kind: 'not-found' });
		expect(state.inserts).toHaveLength(0);
	});

	it('accepts the attach when the row is a never-published placeholder (M3)', async () => {
		state.selectQueue = [[], [{ id: PAGE_ID, content: null, slug: 'draft-abc123' }]];
		state.insertResults = [[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]];
		const result = await savePageDraftWork({
			pageId: PAGE_ID,
			slug: 'x',
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 1 });
	});

	it('syncs the submitted body keys when the first draft attaches (T3)', async () => {
		const KEY = `ab/${'a'.repeat(64)}.png`;
		state.selectQueue = [[], [{ id: PAGE_ID, content: { en: 'x' }, slug: 'live-slug' }]];
		state.insertResults = [[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]];
		await savePageDraftWork({
			pageId: PAGE_ID,
			slug: 'x',
			payload: { ...payloadFromRow(BASE_DRAFT), content: { en: `body /i/${KEY}@full` } },
			autosave: false
		});
		const call = syncMock.mock.calls[0] as unknown as [
			unknown,
			{ type: string; id: string },
			string[]
		];
		expect(call[2]).toEqual([KEY]);
	});

	it('keeps a code-shaped row on discard (content null without the draft- slug, T2)', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: PAGE_ID, slug: 'live-slug', content: null, isDefault: false }]
		];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: PAGE_ID, removedPlaceholder: false });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts]);
	});

	it('keeps a default row on discard even with a placeholder-shaped slug (T2)', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: PAGE_ID, slug: 'draft-abc123', content: null, isDefault: true }]
		];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: PAGE_ID, removedPlaceholder: false });
	});

	it('keeps the row when the page row already vanished before discard (T2)', async () => {
		state.selectQueue = [[BASE_DRAFT], []];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', pageId: PAGE_ID, removedPlaceholder: false });
		// References reverted under the page identity and the draft scope cleared.
		expect(syncMock).toHaveBeenCalledTimes(2);
	});

	it('answers not-found when the page disappears inside the publish transaction (T4)', async () => {
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'ok-slug' }],
			[{ id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false }],
			[]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'not-found' });
	});

	it('answers not-found when the locked draft vanishes inside the transaction (T4)', async () => {
		const livePage = { id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false };
		state.selectQueue = [[{ ...BASE_DRAFT, slug: 'ok-slug' }], [livePage], [livePage], []];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'not-found' });
	});

	it('rejects an inner slug re-check failure with the generic slug error (T4)', async () => {
		const livePage = { id: PAGE_ID, slug: 'live-slug', content: { en: 'x' }, isDefault: false };
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'ok-slug' }],
			[livePage],
			[livePage],
			[{ ...BASE_DRAFT, slug: 'admin' }]
		];
		const result = await publishPageDraft(DRAFT_ID);
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') expect(result.errors.slug).toBeTruthy();
	});

	it('keeps the placeholder write set free of the row-level columns (T5)', async () => {
		state.insertResults = [
			[{ id: PAGE_ID }],
			[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]
		];
		await savePageDraftWork({
			slug: 'fresh-slug',
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		const pageInsert = state.inserts.find((entry) => entry.table === pages);
		// content must stay NULL (the never-published marker the discard gate reads).
		expect(pageInsert?.values).not.toHaveProperty('content');
		expect(pageInsert?.values).not.toHaveProperty('description');
		const draftInsert = state.inserts.find((entry) => entry.table === drafts);
		// Row-level columns stay off the draft write set (divergence 1).
		expect(draftInsert?.values).not.toHaveProperty('title');
		expect(draftInsert?.values).not.toHaveProperty('content');
		expect(draftInsert?.values).not.toHaveProperty('categoryId');
	});
});

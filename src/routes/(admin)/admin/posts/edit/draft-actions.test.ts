import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the P2 editor actions: uuid entry guards, argument
 * mapping into the draft service and the result → response translation
 * (saved/unchanged/throttled payloads, 409 conflicts, redirects). The draft
 * service and the db module are mocked; the service's own behaviour is
 * covered in services/post-drafts.test.ts.
 */
const { dbMock, switchState, syncCheck } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	switchState: {
		selects: [] as unknown[][],
		deletes: [] as { table: unknown; ids: string[] }[],
		deleteBatches: [] as unknown[][],
		updates: [] as Record<string, unknown>[]
	},
	syncCheck:
		vi.fn<(tx: unknown, ref: { type: string; id: string }, next: unknown[]) => Promise<void>>()
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: syncCheck }));
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

import {
	createTranslationDraft,
	discardDraft,
	publishDraft,
	saveDraftWork
} from '$lib/server/services/post-drafts';
import { requireAdminRole } from '$lib/server/authz';
import { posts as postsTable } from '$lib/server/db/content/post.schema';
import { actions } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions
// stay in sync with the zh-cn catalog (same convention as the e2e fixtures
// that assert Chinese copy).
overwriteGetLocale(() => 'zh-cn');

const saveMock = vi.mocked(saveDraftWork);
const publishMock = vi.mocked(publishDraft);
const discardMock = vi.mocked(discardDraft);
const translateMock = vi.mocked(createTranslationDraft);
const guardMock = vi.mocked(requireAdminRole);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const POST_ID = '22222222-2222-2222-2222-222222222222';
const SIBLING_ID = '33333333-3333-3333-3333-333333333333';
const THIRD_ID = '44444444-4444-4444-4444-444444444444';

/** What `save` answers once the working copy is in place (publish then runs). */
const SETTLED_SAVE = {
	kind: 'saved' as const,
	draftId: DRAFT_ID,
	version: 1,
	postId: POST_ID,
	updatedAt: null
};

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/posts/edit', { method: 'POST', body }),
		locals: { admin: { userId: 'user-1', role: 'owner' } }
	};
}

async function callAction(name: string, fields: Record<string, string>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = await fn(makeEvent(fields) as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number; location?: string } };
	}
}

describe('editor actions (P2)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('runs every action behind the admin guard first', async () => {
		saveMock.mockResolvedValue({
			kind: 'saved',
			draftId: DRAFT_ID,
			version: 1,
			postId: POST_ID,
			updatedAt: new Date()
		});
		for (const name of ['save', 'publish', 'discard', 'createTranslation']) {
			await callAction(name, {});
		}
		expect(guardMock).toHaveBeenCalledTimes(4);
	});

	it('rejects malformed ids before calling the service', async () => {
		const badId = await callAction('save', { id: 'not-a-uuid' });
		expect(badId.result).toMatchObject({ status: 400 });
		const badDraft = await callAction('save', { draftId: 'nope' });
		expect(badDraft.result).toMatchObject({ status: 400 });
		// The P1.1 category guard the rewrite had dropped (P2 review finding).
		const badCategory = await callAction('save', { categoryId: 'not-a-uuid' });
		expect(badCategory.result).toMatchObject({
			status: 400,
			data: { message: '分类标识无效' }
		});
		expect(saveMock).not.toHaveBeenCalled();

		const badPublish = await callAction('publish', { draftId: 'nope' });
		expect(badPublish.result).toMatchObject({ status: 400 });
		const badDiscard = await callAction('discard', { draftId: 'nope' });
		expect(badDiscard.result).toMatchObject({ status: 400 });
		const badTranslate = await callAction('createTranslation', { id: 'nope', lang: 'zh-cn' });
		expect(badTranslate.result).toMatchObject({ status: 400 });
	});

	it('stops the action when the guard rejects (no service call)', async () => {
		for (const name of ['save', 'publish', 'discard', 'createTranslation']) {
			guardMock.mockImplementationOnce(() => {
				throw Object.assign(new Error('redirect'), { status: 303, location: '/login' });
			});
			const { thrown } = await callAction(name, {
				id: POST_ID,
				draftId: DRAFT_ID,
				lang: 'zh-cn'
			});
			expect(thrown?.status).toBe(303);
		}
		expect(saveMock).not.toHaveBeenCalled();
		expect(publishMock).not.toHaveBeenCalled();
		expect(discardMock).not.toHaveBeenCalled();
		expect(translateMock).not.toHaveBeenCalled();
	});

	it('maps the save form into the service call (lang filtered by the allowlist)', async () => {
		saveMock.mockResolvedValue({
			kind: 'saved',
			draftId: DRAFT_ID,
			version: 4,
			postId: POST_ID,
			updatedAt: new Date('2026-09-26T10:00:00Z')
		});
		const { result } = await callAction('save', {
			id: POST_ID,
			draftId: DRAFT_ID,
			draftVersion: '3',
			autosave: '1',
			lang: 'xx-bogus',
			title: 'T',
			slug: 'S',
			categoryId: DRAFT_ID,
			summary: 'm',
			tags: 'a,b',
			content: 'C'
		});
		expect(result).toMatchObject({
			saved: true,
			draftId: DRAFT_ID,
			draftVersion: 4,
			postId: POST_ID
		});
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: DRAFT_ID,
				postId: POST_ID,
				expectedVersion: 3,
				// A bogus language is not forwarded; the action asks the writer
				// resolver instead of letting the service guess a base locale.
				lang: 'en',
				autosave: true,
				author: 'user-1',
				payload: expect.objectContaining({ slug: 's', title: 'T' })
			})
		);
	});

	it('forwards the autosave flag and treats a non-numeric version as absent', async () => {
		saveMock.mockResolvedValue({
			kind: 'saved',
			draftId: DRAFT_ID,
			version: 2,
			postId: POST_ID,
			updatedAt: new Date()
		});
		await callAction('save', { draftId: DRAFT_ID, autosave: '0', draftVersion: 'abc' });
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({ autosave: false, expectedVersion: null, lang: 'en' })
		);
	});

	it('answers unchanged and throttled saves without error (retry hint included)', async () => {
		saveMock.mockResolvedValue({
			kind: 'throttled',
			draftId: DRAFT_ID,
			version: 2,
			postId: POST_ID,
			retryAfterMs: 5000
		});
		const throttled = await callAction('save', { draftId: DRAFT_ID, autosave: '1' });
		expect(throttled.result).toMatchObject({
			saved: false,
			reason: 'throttled',
			draftVersion: 2,
			retryAfterMs: 5000
		});

		saveMock.mockResolvedValue({
			kind: 'unchanged',
			draftId: DRAFT_ID,
			version: 2,
			postId: POST_ID
		});
		const unchanged = await callAction('save', { draftId: DRAFT_ID, autosave: '1' });
		expect(unchanged.result).toMatchObject({ saved: false, reason: 'unchanged' });
	});

	it('maps save conflicts and the needs-category gate', async () => {
		saveMock.mockResolvedValue({
			kind: 'conflict',
			server: { draftId: DRAFT_ID, version: 5, updatedAt: new Date() }
		});
		const conflict = await callAction('save', { draftId: DRAFT_ID, draftVersion: '3' });
		expect(conflict.result).toMatchObject({
			status: 409,
			data: expect.objectContaining({ conflict: true })
		});

		saveMock.mockResolvedValue({ kind: 'needs-category' });
		const gate = await callAction('save', { title: 'x' });
		expect(gate.result).toMatchObject({
			status: 400,
			data: expect.objectContaining({ needsCategory: true })
		});
	});

	it('maps busy conflicts and not-found results', async () => {
		// publish is save→publish in one request: the save has to land first.
		saveMock.mockResolvedValue(SETTLED_SAVE);
		publishMock.mockResolvedValue({ kind: 'busy' });
		const publishBusy = await callAction('publish', { draftId: DRAFT_ID });
		expect(publishBusy.result).toMatchObject({ status: 409 });

		discardMock.mockResolvedValue({ kind: 'busy' });
		const discardBusy = await callAction('discard', { draftId: DRAFT_ID });
		expect(discardBusy.result).toMatchObject({ status: 409 });

		saveMock.mockResolvedValue({ kind: 'not-found' });
		expect((await callAction('save', { draftId: DRAFT_ID })).result).toMatchObject({ status: 404 });
		saveMock.mockResolvedValue(SETTLED_SAVE);
		publishMock.mockResolvedValue({ kind: 'not-found' });
		expect((await callAction('publish', { draftId: DRAFT_ID })).result).toMatchObject({
			status: 404
		});
		discardMock.mockResolvedValue({ kind: 'not-found' });
		expect((await callAction('discard', { draftId: DRAFT_ID })).result).toMatchObject({
			status: 404
		});
		translateMock.mockResolvedValue({ kind: 'not-found' });
		expect(
			(await callAction('createTranslation', { id: POST_ID, lang: 'zh-cn' })).result
		).toMatchObject({ status: 404 });
	});

	it('publishes with a redirect and translates failures into responses', async () => {
		saveMock.mockResolvedValue(SETTLED_SAVE);
		publishMock.mockResolvedValue({ kind: 'published', postId: POST_ID, version: 2 });
		const ok = await callAction('publish', { draftId: DRAFT_ID });
		expect(ok.thrown?.status).toBe(303);
		expect(ok.thrown?.location).toContain(`/admin/posts/edit?id=${POST_ID}`);

		publishMock.mockResolvedValue({ kind: 'invalid', errors: { slug: 'Slug 不能为空' } });
		const invalid = await callAction('publish', { draftId: DRAFT_ID });
		expect(invalid.result).toMatchObject({
			status: 400,
			data: expect.objectContaining({ errors: { slug: 'Slug 不能为空' } })
		});

		publishMock.mockResolvedValue({ kind: 'conflict', server: { version: 9 } });
		const conflict = await callAction('publish', { draftId: DRAFT_ID });
		expect(conflict.result).toMatchObject({
			status: 409,
			data: expect.objectContaining({ conflict: true, server: { version: 9 } })
		});

		publishMock.mockResolvedValue({ kind: 'slug-taken' });
		const taken = await callAction('publish', { draftId: DRAFT_ID });
		expect(taken.result).toMatchObject({
			status: 400,
			data: expect.objectContaining({ errors: { slug: expect.any(String) } })
		});
	});

	it('never publishes when the one-request save fails first', async () => {
		// UX-1020-04: the two-request flow published a stale draft whenever the
		// save half lost the race. The combined action must stop instead.
		saveMock.mockResolvedValue({ kind: 'needs-category' });
		const gate = await callAction('publish', { draftId: DRAFT_ID, title: 'x' });
		expect(gate.result).toMatchObject({
			status: 400,
			data: expect.objectContaining({ needsCategory: true })
		});
		expect(publishMock).not.toHaveBeenCalled();

		saveMock.mockResolvedValue({
			kind: 'conflict',
			server: { draftId: null, version: 4, updatedAt: null }
		});
		const conflict = await callAction('publish', { draftId: DRAFT_ID, title: 'x' });
		expect(conflict.result).toMatchObject({ status: 409 });
		expect(publishMock).not.toHaveBeenCalled();
	});

	it('discards a working copy and redirects (placeholder goes back to the list)', async () => {
		discardMock.mockResolvedValue({ kind: 'discarded', postId: POST_ID, removedPlaceholder: true });
		const placeholder = await callAction('discard', { draftId: DRAFT_ID });
		expect(placeholder.thrown?.location).toContain('/admin/posts?discarded=1');

		discardMock.mockResolvedValue({
			kind: 'discarded',
			postId: POST_ID,
			removedPlaceholder: false
		});
		const kept = await callAction('discard', { draftId: DRAFT_ID });
		expect(kept.thrown?.location).toContain(`/admin/posts/edit?id=${POST_ID}&discarded=1`);
	});

	it('validates the target language when creating a translation', async () => {
		const badLang = await callAction('createTranslation', { id: POST_ID, lang: 'de' });
		expect(badLang.result).toMatchObject({ status: 400 });
		expect(translateMock).not.toHaveBeenCalled();

		translateMock.mockResolvedValue({ kind: 'lang-exists' });
		const exists = await callAction('createTranslation', { id: POST_ID, lang: 'zh-cn' });
		expect(exists.result).toMatchObject({ status: 400 });

		// R7 no chaining: only a group source may spawn a translation (P2 review fix).
		translateMock.mockResolvedValue({ kind: 'not-source' });
		const chained = await callAction('createTranslation', { id: POST_ID, lang: 'zh-cn' });
		expect(chained.result).toMatchObject({ status: 400 });

		translateMock.mockResolvedValue({
			kind: 'created',
			postId: '33333333-3333-3333-3333-333333333333'
		});
		const created = await callAction('createTranslation', { id: POST_ID, lang: 'zh-cn' });
		expect(created.thrown?.status).toBe(303);
		expect(created.thrown?.location).toContain('translation=1');
	});
});

/**
 * `?/switchLang` changes the source language of a group. It is destructive in
 * both modes, so the tests pin the two delete plans: promoting an existing
 * version (translations first, source last - the self-FK's SET NULL would
 * otherwise leave two sources in the group) and keeping the current article
 * (only the conflicting version goes).
 */
function switchChain(rows: unknown[]): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		limit: ret,
		for: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
			Promise.resolve(rows).then(resolve, reject)
	});
	return chain;
}

/** The uuid(s) a recorded `where` compares against (drizzle keeps them as chunks). */
function comparedIds(condition: unknown): string[] {
	const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks ?? [];
	const ids: string[] = [];
	for (const chunk of chunks) {
		const kind = (chunk as { constructor?: { name?: string } })?.constructor?.name;
		const value = (chunk as { value?: unknown })?.value;
		if (kind === 'Param' && typeof value === 'string') ids.push(value);
		if (kind === 'Array' && Array.isArray(value)) {
			for (const param of value) {
				const inner = (param as { value?: unknown })?.value;
				if (typeof inner === 'string') ids.push(inner);
			}
		}
	}
	return ids;
}

function switchTx(): Record<string, unknown> {
	const updatedRows: unknown[] = [{ id: POST_ID }];
	return {
		select: () => switchChain(switchState.selects.shift() ?? []),
		delete: (table: unknown) => ({
			where: (condition: unknown) => {
				switchState.deletes.push({ table, ids: comparedIds(condition) });
				const rows = switchState.deleteBatches.shift() ?? [];
				return Object.assign(Promise.resolve(rows), { returning: async () => rows });
			}
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				switchState.updates.push(values);
				return {
					where: () =>
						Object.assign(Promise.resolve(undefined), {
							returning: async () => updatedRows
						})
				};
			}
		})
	};
}

const sourceRow = {
	id: POST_ID,
	lang: 'en',
	translationGroup: 'group-1',
	translatedFromPostId: null
};

describe('editor source-language switch', () => {
	beforeEach(() => {
		guardMock.mockClear();
		syncCheck.mockClear();
		switchState.selects = [];
		switchState.deletes = [];
		switchState.deleteBatches = [];
		switchState.updates = [];
		dbMock.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(switchTx()));
	});

	it('guards and validates the id and the target language first', async () => {
		guardMock.mockImplementationOnce(() => {
			throw Object.assign(new Error('redirect'), { status: 303, location: '/login' });
		});
		const { thrown } = await callAction('switchLang', { id: POST_ID, lang: 'ja' });
		expect(thrown?.status).toBe(303);

		expect((await callAction('switchLang', { id: 'nope', lang: 'ja' })).result).toMatchObject({
			status: 400
		});
		expect((await callAction('switchLang', { id: POST_ID, lang: 'de' })).result).toMatchObject({
			status: 400,
			data: { message: '选择目标语言' }
		});
		expect(dbMock.transaction).not.toHaveBeenCalled();
	});

	it('404s on a missing row and refuses a translation as the starting point', async () => {
		switchState.selects = [[]];
		expect((await callAction('switchLang', { id: POST_ID, lang: 'ja' })).result).toMatchObject({
			status: 404
		});

		switchState.selects = [[{ ...sourceRow, translatedFromPostId: SIBLING_ID }]];
		expect((await callAction('switchLang', { id: POST_ID, lang: 'ja' })).result).toMatchObject({
			status: 400,
			data: { message: '请从源语言版本创建翻译' }
		});
		expect(switchState.deletes).toHaveLength(0);
	});

	it('only redirects when the language is already the source', async () => {
		switchState.selects = [[sourceRow]];
		const same = await callAction('switchLang', { id: POST_ID, lang: 'en' });
		expect(same.thrown?.location).toContain(`/admin/posts/edit?id=${POST_ID}`);
		expect(switchState.deletes).toHaveLength(0);
		expect(switchState.updates).toHaveLength(0);
	});

	it('renames the current row when the target language is free', async () => {
		switchState.selects = [[sourceRow], [{ id: POST_ID, lang: 'en', translatedFromPostId: null }]];
		const result = await callAction('switchLang', {
			id: POST_ID,
			lang: 'ja',
			mode: 'existing'
		});
		expect(result.thrown?.location).toContain(`/admin/posts/edit?id=${POST_ID}`);
		expect(switchState.deletes).toHaveLength(0);
		expect(switchState.updates).toEqual([expect.objectContaining({ lang: 'ja' })]);
	});

	it('promotes the existing version and deletes the rest (translations first)', async () => {
		switchState.selects = [
			[sourceRow],
			[
				{ id: POST_ID, lang: 'en', translatedFromPostId: null },
				{ id: SIBLING_ID, lang: 'ja', translatedFromPostId: POST_ID },
				{ id: THIRD_ID, lang: 'zh-cn', translatedFromPostId: POST_ID }
			]
		];
		switchState.deleteBatches = [[{ id: 'draft-source' }, { id: 'draft-third' }]];
		const result = await callAction('switchLang', {
			id: POST_ID,
			lang: 'ja',
			mode: 'existing'
		});
		expect(result.thrown?.location).toContain(`/admin/posts/edit?id=${SIBLING_ID}`);
		// One drafts batch, then the two doomed rows: the translation before the
		// source, so the group never holds two source rows.
		expect(
			switchState.deletes.map((entry) =>
				entry.table === postsTable ? `post:${entry.ids.join(',')}` : 'draft'
			)
		).toEqual(['draft', `post:${THIRD_ID}`, `post:${POST_ID}`]);
		expect(switchState.updates).toEqual([
			expect.objectContaining({ translatedFromPostId: null, translationOrigin: null })
		]);
		expect(syncCheck.mock.calls.map((call) => call[1])).toEqual([
			{ type: 'draft', id: 'draft-source' },
			{ type: 'draft', id: 'draft-third' },
			{ type: 'post', id: POST_ID },
			{ type: 'post', id: THIRD_ID }
		]);
	});

	it('keeps the current article and deletes the conflicting version (mode=current)', async () => {
		switchState.selects = [
			[sourceRow],
			[
				{ id: POST_ID, lang: 'en', translatedFromPostId: null },
				{ id: SIBLING_ID, lang: 'ja', translatedFromPostId: POST_ID }
			]
		];
		switchState.deleteBatches = [[{ id: 'draft-sibling' }]];
		const result = await callAction('switchLang', {
			id: POST_ID,
			lang: 'ja',
			mode: 'current'
		});
		expect(result.thrown?.location).toContain(`/admin/posts/edit?id=${POST_ID}`);
		expect(
			switchState.deletes.map((entry) =>
				entry.table === postsTable ? `post:${entry.ids.join(',')}` : 'draft'
			)
		).toEqual(['draft', `post:${SIBLING_ID}`]);
		expect(switchState.updates).toEqual([expect.objectContaining({ lang: 'ja' })]);
		expect(syncCheck.mock.calls.map((call) => call[1])).toEqual([
			{ type: 'draft', id: 'draft-sibling' },
			{ type: 'post', id: SIBLING_ID }
		]);
	});

	it('answers 409 when the target language already uses the slug', async () => {
		dbMock.transaction = vi.fn(async () => {
			throw Object.assign(new Error('duplicate key'), { code: '23505' });
		});
		expect((await callAction('switchLang', { id: POST_ID, lang: 'ja' })).result).toMatchObject({
			status: 409,
			data: { message: '目标语言下已存在相同 slug 的文章，请先处理冲突地址。' }
		});
	});
});

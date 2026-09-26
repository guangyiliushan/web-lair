import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the P2 editor actions: uuid entry guards, argument
 * mapping into the draft service and the result → response translation
 * (saved/unchanged/throttled payloads, 409 conflicts, redirects). The draft
 * service and the db module are mocked; the service's own behaviour is
 * covered in services/post-drafts.test.ts.
 */
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
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
import { actions } from './+page.server';

const saveMock = vi.mocked(saveDraftWork);
const publishMock = vi.mocked(publishDraft);
const discardMock = vi.mocked(discardDraft);
const translateMock = vi.mocked(createTranslationDraft);
const guardMock = vi.mocked(requireAdminRole);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const POST_ID = '22222222-2222-2222-2222-222222222222';

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
				lang: null, // bogus language is not forwarded
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
			expect.objectContaining({ autosave: false, expectedVersion: null })
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
		publishMock.mockResolvedValue({ kind: 'busy' });
		const publishBusy = await callAction('publish', { draftId: DRAFT_ID });
		expect(publishBusy.result).toMatchObject({ status: 409 });

		discardMock.mockResolvedValue({ kind: 'busy' });
		const discardBusy = await callAction('discard', { draftId: DRAFT_ID });
		expect(discardBusy.result).toMatchObject({ status: 409 });

		saveMock.mockResolvedValue({ kind: 'not-found' });
		expect((await callAction('save', { draftId: DRAFT_ID })).result).toMatchObject({ status: 404 });
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

		// R7 禁链式: only a group source may spawn a translation (P2 review fix).
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

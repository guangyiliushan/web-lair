import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the N1 notes editor (batch 5): form-value guards
 * (uuid / mood vocabulary / version parsing) run BEFORE any service call,
 * publish/discard/status answer redirects exactly as the plan specifies,
 * and row-level actions (pin / comments / emotions / password) pass
 * normalized parameters through the §2.3 contract.
 */
const { dbMock, state, service } = vi.hoisted(() => {
	const dbMock: Record<string, unknown> = {};
	const state = { selectQueue: [] as unknown[][], saveCalls: [] as unknown[] };
	const service = {
		saveNoteDraftWork: vi.fn(),
		publishNoteDraft: vi.fn(),
		discardNoteDraft: vi.fn(),
		loadNoteDraftByNoteId: vi.fn(),
		setNoteStatus: vi.fn(),
		setNotePin: vi.fn(),
		setNoteAllowComment: vi.fn(),
		setNoteEmotions: vi.fn(),
		setNotePassword: vi.fn(),
		isNotePlaceholderSlug: vi.fn((slug: string) => slug.startsWith('note-')),
		requireAdminRole: vi.fn()
	};
	return { dbMock, state, service };
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/server/services/note-drafts', () => ({
	saveNoteDraftWork: service.saveNoteDraftWork,
	publishNoteDraft: service.publishNoteDraft,
	discardNoteDraft: service.discardNoteDraft,
	loadNoteDraftByNoteId: service.loadNoteDraftByNoteId,
	setNoteStatus: service.setNoteStatus,
	setNotePin: service.setNotePin,
	setNoteAllowComment: service.setNoteAllowComment,
	setNoteEmotions: service.setNoteEmotions,
	setNotePassword: service.setNotePassword,
	isNotePlaceholderSlug: service.isNotePlaceholderSlug
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));

import { actions } from './+page.server';

const NOTE_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '22222222-2222-2222-2222-222222222222';
const TOPIC_ID = '33333333-3333-3333-3333-333333333333';

function chain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		leftJoin: ret,
		groupBy: ret,
		offset: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.selectQueue = [];
	dbMock.select = () => chain();
});

type ActionEvent = Parameters<typeof actions.save>[0];

function event(fields: Record<string, string | string[]>): ActionEvent {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) for (const v of value) fd.append(key, v);
		else fd.set(key, value);
	}
	return {
		request: new Request('http://localhost/admin/notes/edit', { method: 'POST', body: fd }),
		locals: { admin: { userId: 'user-1' }, user: { id: 'user-1' } }
	} as unknown as ActionEvent;
}

async function run(
	name: keyof typeof actions,
	fields: Record<string, string | string[]>
): Promise<{ status: number; data?: Record<string, unknown>; location?: string }> {
	try {
		const result = (await actions[name]!(event(fields))) as {
			status?: number;
			data?: Record<string, unknown>;
		};
		if (result && typeof result === 'object' && 'status' in result) {
			return { status: result.status ?? 200, data: result.data };
		}
		return { status: 200, data: result as Record<string, unknown> };
	} catch (thrown) {
		const response = thrown as { status?: number; location?: string };
		return { status: response.status ?? 500, location: response.location };
	}
}

const BASE_SAVE = {
	id: NOTE_ID,
	draftId: DRAFT_ID,
	draftVersion: '4',
	title: 'Title',
	slug: 'title',
	topicId: TOPIC_ID,
	mood: 'good',
	weatherCode: '61',
	temperatureC: '21.5',
	latitude: '25.03',
	longitude: '121.56',
	location: 'Taipei',
	content: 'Body'
};

describe('notes editor · save', () => {
	it('rejects malformed identifiers before any service call', async () => {
		expect((await run('save', { id: 'not-a-uuid' })).status).toBe(400);
		expect((await run('save', { draftId: 'nope' })).status).toBe(400);
		expect((await run('save', { topicId: 'nope' })).status).toBe(400);
		expect(service.saveNoteDraftWork).not.toHaveBeenCalled();
	});

	it('rejects mood tokens outside the closed vocabulary', async () => {
		const result = await run('save', { ...BASE_SAVE, mood: 'ecstatic' });
		expect(result.status).toBe(400);
		expect(service.saveNoteDraftWork).not.toHaveBeenCalled();
	});

	it('passes parsed version / language / payload through to the service', async () => {
		service.saveNoteDraftWork.mockResolvedValue({
			kind: 'saved',
			draftId: DRAFT_ID,
			version: 5,
			noteId: NOTE_ID,
			updatedAt: new Date()
		});
		const result = await run('save', { ...BASE_SAVE, autosave: '1', lang: 'zh-cn' });
		expect(result.status).toBe(200);
		expect(result.data).toMatchObject({ saved: true, draftId: DRAFT_ID, draftVersion: 5 });
		expect(service.saveNoteDraftWork).toHaveBeenCalledTimes(1);
		const call = service.saveNoteDraftWork.mock.calls[0][0] as {
			noteId: string;
			draftId: string;
			expectedVersion: number;
			lang: string | null;
			autosave: boolean;
			author: string | null;
			payload: Record<string, string>;
		};
		expect(call.noteId).toBe(NOTE_ID);
		expect(call.draftId).toBe(DRAFT_ID);
		expect(call.expectedVersion).toBe(4);
		expect(call.lang).toBe('zh-cn');
		expect(call.autosave).toBe(true);
		expect(call.author).toBe('user-1');
		expect(call.payload).toMatchObject({
			title: 'Title',
			slug: 'title',
			topicId: TOPIC_ID,
			mood: 'good',
			weatherCode: '61',
			latitude: '25.03'
		});
	});

	it('treats a non-numeric version as absent and unknown languages as null', async () => {
		service.saveNoteDraftWork.mockResolvedValue({
			kind: 'unchanged',
			draftId: DRAFT_ID,
			version: 3,
			noteId: NOTE_ID
		});
		await run('save', { ...BASE_SAVE, draftVersion: 'abc', lang: 'xx-xx' });
		const call = service.saveNoteDraftWork.mock.calls[0][0] as {
			expectedVersion: number | null;
			lang: string | null;
		};
		// 'abc' → null, and a language outside OPTION_LANGS must not reach the row.
		expect(call.expectedVersion).toBeNull();
		expect(call.lang).toBeNull();
	});

	it('answers a 409 conflict with the server snapshot flag', async () => {
		service.saveNoteDraftWork.mockResolvedValue({
			kind: 'conflict',
			server: { version: 7, updatedAt: new Date(), author: null }
		});
		const result = await run('save', BASE_SAVE);
		expect(result.status).toBe(409);
		expect(result.data).toMatchObject({ conflict: true });
	});
});

describe('notes editor · publish / discard / status', () => {
	it('translates publish outcomes', async () => {
		expect((await run('publish', { draftId: 'nope' })).status).toBe(400);

		service.publishNoteDraft.mockResolvedValueOnce({
			kind: 'invalid',
			errors: { title: '标题不能为空' }
		});
		const invalid = await run('publish', { draftId: DRAFT_ID });
		expect(invalid.status).toBe(400);
		expect(invalid.data).toMatchObject({ errors: { title: '标题不能为空' } });

		service.publishNoteDraft.mockResolvedValueOnce({ kind: 'slug-taken' });
		expect((await run('publish', { draftId: DRAFT_ID })).status).toBe(400);

		service.publishNoteDraft.mockResolvedValueOnce({ kind: 'published', noteId: NOTE_ID });
		const ok = await run('publish', { draftId: DRAFT_ID });
		expect(ok.status).toBe(303);
		expect(ok.location).toBe(`/admin/notes/edit?id=${NOTE_ID}&published=1`);
	});

	it('routes discard redirects by placeholder state', async () => {
		service.discardNoteDraft.mockResolvedValueOnce({ kind: 'discarded', removedPlaceholder: true });
		const removed = await run('discard', { draftId: DRAFT_ID });
		expect(removed.location).toBe('/admin/notes?discarded=1');

		service.discardNoteDraft.mockResolvedValueOnce({
			kind: 'discarded',
			removedPlaceholder: false,
			noteId: NOTE_ID
		});
		const kept = await run('discard', { draftId: DRAFT_ID });
		expect(kept.location).toBe(`/admin/notes/edit?id=${NOTE_ID}&discarded=1`);
	});

	it('only accepts the three status verbs and maps redirects', async () => {
		expect((await run('status', { id: NOTE_ID, action: 'delete' })).status).toBe(400);

		service.setNoteStatus.mockResolvedValueOnce({ kind: 'updated', status: 'trash' });
		const trashed = await run('status', { id: NOTE_ID, action: 'trash' });
		expect(trashed.location).toBe('/admin/notes?trashed=1');

		service.setNoteStatus.mockResolvedValueOnce({ kind: 'updated', status: 'private' });
		expect((await run('status', { id: NOTE_ID, action: 'private' })).location).toBe(
			`/admin/notes/edit?id=${NOTE_ID}&private=1`
		);

		service.setNoteStatus.mockResolvedValueOnce({ kind: 'updated', status: 'published' });
		expect((await run('status', { id: NOTE_ID, action: 'restore' })).location).toBe(
			`/admin/notes/edit?id=${NOTE_ID}&restored=1`
		);

		service.setNoteStatus.mockResolvedValueOnce({ kind: 'not-found' });
		expect((await run('status', { id: NOTE_ID, action: 'trash' })).status).toBe(404);
	});
});

describe('notes editor · row-level settings', () => {
	it('pin/comments parse the toggle value as strict "1"', async () => {
		service.setNotePin.mockResolvedValue({ kind: 'updated' });
		service.setNoteAllowComment.mockResolvedValue({ kind: 'updated' });
		await run('pin', { id: NOTE_ID, value: '1' });
		await run('comments', { id: NOTE_ID, value: '0' });
		expect(service.setNotePin).toHaveBeenCalledWith(NOTE_ID, true);
		expect(service.setNoteAllowComment).toHaveBeenCalledWith(NOTE_ID, false);
	});

	it('emotions collect every repeated form field', async () => {
		service.setNoteEmotions.mockResolvedValue({ kind: 'updated' });
		const result = await run('emotions', { id: NOTE_ID, emotions: ['happy', 'calm'] });
		expect(result.status).toBe(200);
		expect(service.setNoteEmotions).toHaveBeenCalledWith(NOTE_ID, ['happy', 'calm']);

		service.setNoteEmotions.mockResolvedValueOnce({
			kind: 'invalid',
			message: '情绪取值无效'
		});
		expect((await run('emotions', { id: NOTE_ID })).status).toBe(400);
	});

	it('password clear=1 wins over any typed value; empty clears', async () => {
		service.setNotePassword.mockResolvedValue({ kind: 'updated' });
		await run('password', { id: NOTE_ID, password: 'typed', clear: '1' });
		expect(service.setNotePassword).toHaveBeenCalledWith(NOTE_ID, '');
		await run('password', { id: NOTE_ID, password: 'hunter2' });
		expect(service.setNotePassword).toHaveBeenCalledWith(NOTE_ID, 'hunter2');

		service.setNotePassword.mockResolvedValueOnce({
			kind: 'invalid',
			message: '密码最长 200 字符'
		});
		expect((await run('password', { id: NOTE_ID, password: 'x'.repeat(201) })).status).toBe(400);
	});
});

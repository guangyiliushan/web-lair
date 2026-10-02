import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the public note detail page (N1): open rows render
 * and load their threads, gated rows ship the public shell only (body and
 * metadata withheld, no discussion) until the unlock cookie verifies, the
 * slug fallback 301s exactly once, missing languages 404 with an ordered
 * hint, and the unlock action verifies → signs → sets the row cookie while
 * counting only FAILED attempts against the limiter.
 */
const { dbMock, state, service } = vi.hoisted(() => {
	const dbMock: Record<string, unknown> = {};
	const state = { selectQueue: [] as unknown[][] };
	const service = {
		findVisibleNote: vi.fn(),
		getNoteBody: vi.fn(),
		getNoteGateRecord: vi.fn(),
		listVisibleGroupVersions: vi.fn(),
		listVisibleNoteLanguages: vi.fn(),
		findSlugTargetId: vi.fn(),
		loadThreads: vi.fn(),
		resolveCommentNoteTarget: vi.fn(),
		submitComment: vi.fn(),
		verifyNotePassword: vi.fn(),
		verifyNoteUnlockToken: vi.fn(),
		signNoteUnlockToken: vi.fn(),
		noteGateTtlSeconds: vi.fn(),
		renderMarkdownToHtml: vi.fn(),
		getOption: vi.fn(),
		requireUser: vi.fn(),
		rateLimit: vi.fn(),
		getCache: vi.fn(),
		noteDateLabel: vi.fn()
	};
	return { dbMock, state, service };
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/services/notes', () => ({
	findVisibleNote: service.findVisibleNote,
	getNoteBody: service.getNoteBody,
	getNoteGateRecord: service.getNoteGateRecord,
	listVisibleGroupVersions: service.listVisibleGroupVersions,
	listVisibleNoteLanguages: service.listVisibleNoteLanguages
}));
vi.mock('$lib/server/services/note-gate', () => ({
	verifyNotePassword: service.verifyNotePassword,
	verifyNoteUnlockToken: service.verifyNoteUnlockToken,
	signNoteUnlockToken: service.signNoteUnlockToken,
	noteGateTtlSeconds: service.noteGateTtlSeconds,
	noteUnlockCookieName: (id: string) => `wl_note_${id}`,
	NOTE_GATE_RATE_LIMIT: { limit: 5, windowSeconds: 60 }
}));
vi.mock('$lib/server/services/comments', () => ({
	loadThreads: service.loadThreads,
	resolveCommentNoteTarget: service.resolveCommentNoteTarget,
	submitComment: service.submitComment
}));
vi.mock('$lib/server/services/slug-resolver', () => ({
	findSlugTargetId: service.findSlugTargetId
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: service.getOption
}));
vi.mock('$lib/server/markdown', () => ({
	renderMarkdownToHtml: service.renderMarkdownToHtml
}));
vi.mock('$lib/server/authz', () => ({
	requireUser: service.requireUser
}));
vi.mock('$lib/server/cache', () => ({ getCache: service.getCache }));
vi.mock('$lib/server/cache/store', () => ({ rateLimit: service.rateLimit }));
vi.mock('$lib/utils/note-date', () => ({
	noteDateLabel: service.noteDateLabel
}));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string) => href,
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_t, key) => () => String(key) })
}));

import { actions, load } from './+page.server';

const NOTE_ID = '11111111-1111-1111-1111-111111111111';
const PUBLISHED = new Date('2026-10-01T10:00:00Z');

const openNote = {
	id: NOTE_ID,
	nid: 1,
	slug: 'hello',
	title: 'Hello',
	content: 'Diary **body**',
	lang: 'en',
	tz: null,
	mood: 'good',
	emotions: ['happy', 'calm'],
	weatherCode: 61,
	temperatureC: '21.5',
	coordinates: { latitude: 25.03, longitude: 121.56 },
	location: 'Taipei',
	publishedAt: PUBLISHED,
	pinAt: null,
	allowComment: true,
	locked: false,
	translationGroup: 'group-1',
	topic: { name: 'Travel', slug: 'travel', icon: 'plane' }
};

const lockedNote = {
	...openNote,
	content: null,
	tz: null,
	mood: null,
	emotions: null,
	weatherCode: null,
	temperatureC: null,
	coordinates: null,
	location: null,
	locked: true
};

const threads = { roots: [], visibleCount: 0, truncated: false };

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

function makeEvent(overrides: Record<string, unknown> = {}) {
	return {
		params: { slug: 'hello' },
		url: new URL('http://localhost/en/notes/hello'),
		cookies: { get: vi.fn(() => null), set: vi.fn() },
		locals: { user: null, profile: null },
		request: { formData: vi.fn(async () => new FormData()) },
		getClientAddress: vi.fn(() => '1.2.3.4'),
		...overrides
	} as never;
}

beforeEach(() => {
	state.selectQueue = [];
	Object.assign(dbMock, { select: vi.fn(() => makeChain(state.selectQueue.shift() ?? [])) });
	for (const fn of Object.values(service)) fn.mockReset?.();
	service.findVisibleNote.mockResolvedValue(openNote);
	service.getOption.mockImplementation(async (key: string) =>
		key === 'site.timezone' ? 'UTC' : { ttlDays: 30 }
	);
	service.getNoteBody.mockResolvedValue('Diary **body**');
	service.getNoteGateRecord.mockResolvedValue({ id: NOTE_ID, passwordHash: 'phc' });
	service.listVisibleGroupVersions.mockResolvedValue([
		{ lang: 'en', slug: 'hello' },
		{ lang: 'zh-cn', slug: 'hello-zh' }
	]);
	service.listVisibleNoteLanguages.mockResolvedValue([]);
	service.findSlugTargetId.mockResolvedValue(null);
	service.loadThreads.mockResolvedValue(threads);
	service.renderMarkdownToHtml.mockImplementation(async (md: string) => `rendered:${md}`);
	service.noteDateLabel.mockReturnValue('October 1, 2026');
	service.verifyNoteUnlockToken.mockReturnValue(false);
	service.verifyNotePassword.mockReturnValue(false);
	service.signNoteUnlockToken.mockReturnValue('123.sig');
	service.noteGateTtlSeconds.mockResolvedValue(30 * 86400);
	service.rateLimit.mockResolvedValue({ allowed: true, count: 1 });
	service.requireUser.mockReturnValue({ id: 'u-1', name: 'Reader', emailVerified: true });
	service.resolveCommentNoteTarget.mockResolvedValue(NOTE_ID);
	service.submitComment.mockResolvedValue({ kind: 'created', id: 'c-1', state: 'pending' });
});

describe('note detail load', () => {
	it('renders an open note with threads and hreflang alternates', async () => {
		const data = (await load(makeEvent())) as {
			html: string;
			gate: { locked: boolean; unlocked: boolean };
			discussion: unknown;
			seo: { path: string; alternates: unknown[] };
			note: { title: string; mood: string };
		};
		expect(data.html).toBe('rendered:Diary **body**');
		expect(data.gate).toEqual({ locked: false, unlocked: false });
		expect(data.discussion).toEqual(threads);
		expect(data.seo.path).toBe('/notes/hello');
		expect(data.seo.alternates).toEqual([
			{ lang: 'en', path: '/notes/hello' },
			{ lang: 'zh-cn', path: '/notes/hello-zh' }
		]);
		expect(data.note.mood).toBe('good');
		expect(service.loadThreads).toHaveBeenCalledWith({
			targetType: 'note',
			targetId: NOTE_ID,
			viewerId: null
		});
	});

	it('keeps a gated note closed without a valid cookie: no body, no discussion', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		const data = (await load(makeEvent())) as {
			html: string;
			gate: { locked: boolean; unlocked: boolean };
			discussion: unknown;
			note: { mood: string | null };
		};
		expect(data.gate).toEqual({ locked: true, unlocked: false });
		expect(data.html).toBe('');
		expect(data.discussion).toBeNull();
		expect(data.note.mood).toBeNull();
		expect(service.getNoteBody).not.toHaveBeenCalled();
	});

	it('unlocks a gated note when the cookie token verifies', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		service.verifyNoteUnlockToken.mockReturnValue(true);
		const data = (await load(
			makeEvent({ cookies: { get: vi.fn(() => '123.sig'), set: vi.fn() } })
		)) as { html: string; gate: { locked: boolean; unlocked: boolean }; discussion: unknown };
		expect(data.gate).toEqual({ locked: true, unlocked: true });
		expect(service.getNoteBody).toHaveBeenCalledWith(NOTE_ID);
		expect(data.html).toBe('rendered:Diary **body**');
		expect(data.discussion).toEqual(threads);
	});

	it('404s with no hint when the note does not exist anywhere', async () => {
		service.findVisibleNote.mockResolvedValue(null);
		await expect(load(makeEvent())).rejects.toMatchObject({ status: 404 });
	});

	it('404s with an ordered language hint when other locales have the slug', async () => {
		service.findVisibleNote.mockResolvedValue(null);
		service.listVisibleNoteLanguages.mockResolvedValue(['ja', 'zh-cn']);
		await expect(load(makeEvent())).rejects.toMatchObject({
			status: 404,
			body: {
				message: 'error_note_language_hint',
				available: [
					{ lang: 'zh-cn', href: '/notes/hello' },
					{ lang: 'ja', href: '/notes/hello' }
				]
			}
		});
	});

	it('301s a retired slug to its visible target, preserving the query string', async () => {
		service.findVisibleNote.mockResolvedValue(null);
		service.findSlugTargetId.mockResolvedValue(NOTE_ID);
		state.selectQueue = [[{ slug: 'hello-new' }]];
		await expect(
			load(makeEvent({ url: new URL('http://localhost/en/notes/hello?ref=x') }))
		).rejects.toMatchObject({ status: 301, location: '/notes/hello-new?ref=x' });
	});

	it('does not redirect a retired slug whose target row is gone', async () => {
		service.findVisibleNote.mockResolvedValue(null);
		service.findSlugTargetId.mockResolvedValue(NOTE_ID);
		state.selectQueue = [[]];
		await expect(load(makeEvent())).rejects.toMatchObject({ status: 404 });
	});
});

describe('note unlock action', () => {
	it('sets the row cookie and redirects on a correct password', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		service.verifyNotePassword.mockReturnValue(true);
		const set = vi.fn();
		await expect(
			actions.unlock(makeEvent({ cookies: { get: vi.fn(), set } }) as never)
		).rejects.toMatchObject({ status: 303, location: '/notes/hello' });
		expect(set).toHaveBeenCalledWith(
			'wl_note_11111111-1111-1111-1111-111111111111',
			'123.sig',
			expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 })
		);
		// A correct password never charges the limiter.
		expect(service.rateLimit).not.toHaveBeenCalled();
	});

	it('fails 403 on a wrong password and charges the limiter', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		const result = await actions.unlock(makeEvent() as never);
		expect(result).toMatchObject({ status: 403, data: { message: 'notes_unlock_wrong' } });
		expect(service.rateLimit).toHaveBeenCalledWith(undefined, 'limits:note-gate:1.2.3.4', 5, 60);
	});

	it('fails 429 once the failure budget is spent', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		service.rateLimit.mockResolvedValue({ allowed: false, count: 5 });
		const result = await actions.unlock(makeEvent() as never);
		expect(result).toMatchObject({ status: 429, data: { message: 'notes_unlock_limited' } });
	});

	it('fails 404 for a note that is not gated', async () => {
		service.findVisibleNote.mockResolvedValue(openNote);
		const result = await actions.unlock(makeEvent() as never);
		expect(result).toMatchObject({ status: 404, data: { message: 'notes_unlock_unavailable' } });
		expect(service.verifyNotePassword).not.toHaveBeenCalled();
	});

	it('fails 403 when the stored gate record is missing', async () => {
		service.findVisibleNote.mockResolvedValue(lockedNote);
		service.getNoteGateRecord.mockResolvedValue(null);
		const result = await actions.unlock(makeEvent() as never);
		expect(result).toMatchObject({ status: 403 });
	});
});

describe('note comment actions', () => {
	it('submits a note comment through the shared service', async () => {
		const result = await actions.comment(makeEvent() as never);
		expect(result).toEqual({ submitted: 'pending' });
		expect(service.resolveCommentNoteTarget).toHaveBeenCalledWith('en', 'hello', expect.any(Date));
		expect(service.submitComment).toHaveBeenCalledWith(
			expect.objectContaining({ targetType: 'note', targetId: NOTE_ID, parentId: null })
		);
	});

	it('fails 404 when no commentable note matches the slug', async () => {
		service.resolveCommentNoteTarget.mockResolvedValue(null);
		const result = await actions.comment(makeEvent() as never);
		expect(result).toMatchObject({ status: 404, data: { message: 'comment_error_unavailable' } });
	});

	it('fails 403 for a signed-in reader without a verified email', async () => {
		service.requireUser.mockReturnValue({ id: 'u-1', name: 'Reader', emailVerified: false });
		const result = await actions.comment(makeEvent() as never);
		expect(result).toMatchObject({ status: 403, data: { message: 'comment_verify_hint' } });
	});
});

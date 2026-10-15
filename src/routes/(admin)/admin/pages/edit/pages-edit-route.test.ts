import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the pages editor (T6 unit side; P2 metadata + P5-2
 * draft flow): load addressing, the save guards (uuid / empty title / icon
 * whitelist / external URL / reserved and default-row slug rules), the
 * md-row narrowing (icon / external_url only), the draft actions
 * (saveDraft / publish / discard) parameter normalisation and redirect
 * mapping, and the 23505 → 409 conflict mapping. The db module is mocked
 * with a recording chain; the page-drafts service is mocked function-wise.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		setCalls: [] as Record<string, unknown>[],
		nextThrow: null as unknown
	},
	service: {
		requireAdminRole: vi.fn(),
		savePageDraftWork: vi.fn(),
		publishPageDraft: vi.fn(),
		discardPageDraft: vi.fn(),
		loadPageDraftByPageId: vi.fn(),
		isPagePlaceholderSlug: vi.fn((slug: string) => slug.startsWith('draft-'))
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en')
}));
vi.mock('$lib/server/services/page-drafts', () => ({
	savePageDraftWork: service.savePageDraftWork,
	publishPageDraft: service.publishPageDraft,
	discardPageDraft: service.discardPageDraft,
	loadPageDraftByPageId: service.loadPageDraftByPageId,
	isPagePlaceholderSlug: service.isPagePlaceholderSlug
}));

import { actions, load } from './+page.server';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '22222222-2222-2222-2222-222222222222';

function formEvent(entries: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(entries)) body.set(key, value);
	return {
		request: new Request('http://localhost/admin/pages/edit', { method: 'POST', body }),
		locals: { admin: { userId: 'user-1' }, user: { id: 'user-1' } }
	};
}

function selectChain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: ret,
		limit: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

async function run(
	name: keyof typeof actions,
	fields: Record<string, string>
): Promise<{ status: number; data?: Record<string, unknown>; location?: string }> {
	try {
		const result = (await actions[name]!(formEvent(fields) as never)) as {
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

const baseRow = { id: PAGE_ID, slug: 'about', isDefault: false, content: null };
const mdRow = { id: PAGE_ID, slug: 'live-slug', isDefault: false, content: { en: 'x' } };

function resetState() {
	state.selectQueue = [];
	state.returningQueue = [];
	state.setCalls = [];
	state.nextThrow = null;
	vi.clearAllMocks();
	Object.assign(dbMock, {
		select: vi.fn(() => selectChain()),
		update: vi.fn(() => ({
			set: vi.fn((values: Record<string, unknown>) => {
				state.setCalls.push(values);
				return {
					where: vi.fn(() => ({
						returning: vi.fn(async () => {
							if (state.nextThrow) {
								const thrown = state.nextThrow;
								state.nextThrow = null;
								throw thrown;
							}
							return state.returningQueue.shift() ?? [];
						})
					}))
				};
			})
		}))
	});
}

describe('admin page editor · metadata save (P2)', () => {
	beforeEach(resetState);

	it('404s malformed ids before touching the database', async () => {
		await expect(
			load({ url: new URL('http://localhost/admin/pages/edit?id=nope') } as never)
		).rejects.toMatchObject({ status: 404 });
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('validates the save payload before touching the row', async () => {
		// malformed id
		expect((await run('save', { id: 'nope' })).status).toBe(400);

		// missing row
		state.selectQueue = [[]];
		expect((await run('save', { id: PAGE_ID })).status).toBe(404);

		// all-empty title
		state.selectQueue = [[baseRow]];
		expect(
			(
				await run('save', {
					id: PAGE_ID,
					title_en: '  ',
					'title_zh-cn': '',
					title_ja: '',
					slug: 'about'
				})
			).status
		).toBe(400);

		// icon not whitelisted
		state.selectQueue = [[baseRow]];
		expect((await run('save', { id: PAGE_ID, title_en: 'X', icon: 'evil', slug: 'about' })).status).toBe(
			400
		);

		// bad external URL
		state.selectQueue = [[baseRow]];
		expect(
			(await run('save', { id: PAGE_ID, title_en: 'X', externalUrl: 'ftp://x', slug: 'about' })).status
		).toBe(400);

		// reserved slug on change
		state.selectQueue = [[baseRow]];
		expect((await run('save', { id: PAGE_ID, title_en: 'X', slug: 'admin' })).status).toBe(400);

		// default-row slug change refused
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		expect(
			(await run('save', { id: PAGE_ID, title_en: 'X', slug: 'about-next' })).status
		).toBe(400);
	});

	it('saves trimmed jsonb and maps duplicate slug to 409', async () => {
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		state.returningQueue = [[{ id: PAGE_ID }]];

		const ok = await run('save', {
			id: PAGE_ID,
			title_en: ' About Me ',
			'title_zh-cn': '',
			title_ja: ' アバウト ',
			description_en: ' D ',
			description_ja: '',
			icon: '',
			externalUrl: '',
			slug: 'about'
		});
		expect(ok.data).toEqual({ success: true });
		expect(service.requireAdminRole).toHaveBeenCalled();
		expect(state.setCalls[0]).toEqual({
			title: { en: 'About Me', ja: 'アバウト' },
			description: { en: 'D' },
			icon: null,
			externalUrl: null,
			slug: 'about'
		});

		state.selectQueue = [[baseRow]];
		state.nextThrow = Object.assign(new Error('duplicate key'), {
			cause: { code: '23505' }
		});
		expect((await run('save', { id: PAGE_ID, title_en: 'X', slug: 'solo' })).status).toBe(409);

		state.selectQueue = [[baseRow]];
		state.returningQueue = [[]];
		expect((await run('save', { id: PAGE_ID, title_en: 'X', slug: 'about' })).status).toBe(404);
	});

	it('accepts any single content language and rethrows non-conflict errors', async () => {
		// zh-cn alone is a valid title; en is not required.
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		state.returningQueue = [[{ id: PAGE_ID }]];

		const ok = await run('save', { id: PAGE_ID, 'title_zh-cn': '仅中文标题', slug: 'about' });
		expect(ok.data).toEqual({ success: true });
		expect(state.setCalls[0]).toMatchObject({ title: { 'zh-cn': '仅中文标题' } });

		// A non-unique-violation error bubbles instead of mapping to 409.
		state.selectQueue = [[baseRow]];
		state.nextThrow = new Error('boom');
		await expect(actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'about' }) as never)).rejects.toThrow(
			'boom'
		);
	});

	it('narrows md-row saves to the row properties (icon / external_url only)', async () => {
		state.selectQueue = [[mdRow]];
		state.returningQueue = [[{ id: PAGE_ID }]];
		const ok = await run('save', {
			id: PAGE_ID,
			icon: 'coffee',
			externalUrl: 'https://x.example',
			title_en: 'SHOULD NOT LAND',
			slug: 'should-not-land'
		});
		expect(ok.data).toEqual({ success: true });
		// Exactly the two property keys - the editor owns everything else.
		expect(state.setCalls[0]).toEqual({ icon: 'coffee', externalUrl: 'https://x.example' });

		// The icon whitelist still applies on md rows.
		state.selectQueue = [[mdRow]];
		expect((await run('save', { id: PAGE_ID, icon: 'evil', externalUrl: '' })).status).toBe(400);

		// Empty properties clear to null.
		state.selectQueue = [[mdRow]];
		state.returningQueue = [[{ id: PAGE_ID }]];
		await run('save', { id: PAGE_ID, icon: '', externalUrl: '' });
		expect(state.setCalls[1]).toEqual({ icon: null, externalUrl: null });
	});

	it('treats a never-published placeholder like an md row (props-only save, B1/M3)', async () => {
		state.selectQueue = [[{ id: PAGE_ID, slug: 'draft-abc123', isDefault: false, content: null }]];
		state.returningQueue = [[{ id: PAGE_ID }]];
		const ok = await run('save', {
			id: PAGE_ID,
			icon: 'coffee',
			externalUrl: '',
			title_en: 'SHOULD NOT LAND',
			slug: 'should-not-land'
		});
		expect(ok.data).toEqual({ success: true });
		expect(state.setCalls[0]).toEqual({ icon: 'coffee', externalUrl: null });
	});
});

describe('pages editor · draft actions (P5-2)', () => {
	beforeEach(resetState);

	const BASE_SAVE = {
		id: PAGE_ID,
		draftId: DRAFT_ID,
		draftVersion: '4',
		slug: ' Fresh-Slug ',
		title_en: ' English title ',
		'title_zh-cn': '',
		description_en: ' D ',
		content_en: '# Body',
		content_ja: ''
	};

	it('rejects malformed identifiers before any service call', async () => {
		expect((await run('saveDraft', { id: 'nope' })).status).toBe(400);
		expect((await run('saveDraft', { draftId: 'nope' })).status).toBe(400);
		expect((await run('publish', { draftId: 'nope' })).status).toBe(400);
		expect((await run('discard', { draftId: 'nope' })).status).toBe(400);
		expect(service.savePageDraftWork).not.toHaveBeenCalled();
		expect(service.publishPageDraft).not.toHaveBeenCalled();
		expect(service.discardPageDraft).not.toHaveBeenCalled();
	});

	it('passes parsed version / trimmed maps / lowered slug through to the service', async () => {
		service.savePageDraftWork.mockResolvedValueOnce({
			kind: 'saved',
			draftId: DRAFT_ID,
			version: 5,
			pageId: PAGE_ID,
			updatedAt: new Date()
		});
		const result = await run('saveDraft', { ...BASE_SAVE, autosave: '1' });
		expect(result.status).toBe(200);
		expect(result.data).toMatchObject({
			saved: true,
			draftId: DRAFT_ID,
			draftVersion: 5,
			pageId: PAGE_ID
		});
		expect(service.savePageDraftWork).toHaveBeenCalledTimes(1);
		const call = service.savePageDraftWork.mock.calls[0][0] as {
			pageId: string;
			draftId: string;
			expectedVersion: number;
			slug: string;
			autosave: boolean;
			author: string | null;
			payload: {
				title: Record<string, string>;
				description: Record<string, string>;
				content: Record<string, string>;
			};
		};
		expect(call.pageId).toBe(PAGE_ID);
		expect(call.draftId).toBe(DRAFT_ID);
		expect(call.expectedVersion).toBe(4);
		expect(call.slug).toBe('fresh-slug');
		expect(call.autosave).toBe(true);
		expect(call.author).toBe('user-1');
		// Titles / descriptions trim; markdown bodies keep their shape; empty
		// locales drop out of the maps.
		expect(call.payload).toEqual({
			title: { en: 'English title' },
			description: { en: 'D' },
			content: { en: '# Body' }
		});
	});

	it('treats a non-numeric version as absent and maps unchanged / throttled', async () => {
		service.savePageDraftWork.mockResolvedValueOnce({
			kind: 'unchanged',
			draftId: DRAFT_ID,
			version: 3,
			pageId: PAGE_ID
		});
		const unchanged = await run('saveDraft', { ...BASE_SAVE, draftVersion: 'abc' });
		expect(unchanged.data).toMatchObject({ saved: false, reason: 'unchanged' });
		expect(
			(service.savePageDraftWork.mock.calls[0][0] as { expectedVersion: number | null })
				.expectedVersion
		).toBeNull();

		service.savePageDraftWork.mockResolvedValueOnce({
			kind: 'throttled',
			draftId: DRAFT_ID,
			version: 3,
			pageId: PAGE_ID,
			retryAfterMs: 9000
		});
		const throttled = await run('saveDraft', BASE_SAVE);
		expect(throttled.data).toMatchObject({ saved: false, reason: 'throttled', retryAfterMs: 9000 });
	});

	it('answers a 409 conflict and a 404 not-found verbatim', async () => {
		service.savePageDraftWork.mockResolvedValueOnce({
			kind: 'conflict',
			server: { draftId: DRAFT_ID, version: 7, updatedAt: new Date() }
		});
		const conflict = await run('saveDraft', BASE_SAVE);
		expect(conflict.status).toBe(409);
		expect(conflict.data).toMatchObject({ conflict: true });

		service.savePageDraftWork.mockResolvedValueOnce({ kind: 'not-found' });
		expect((await run('saveDraft', BASE_SAVE)).status).toBe(404);
	});

	it('translates publish outcomes', async () => {
		service.publishPageDraft.mockResolvedValueOnce({
			kind: 'invalid',
			errors: { title: '标题至少填写一种语言' }
		});
		const invalid = await run('publish', { draftId: DRAFT_ID });
		expect(invalid.status).toBe(400);
		expect(invalid.data).toMatchObject({ errors: { title: '标题至少填写一种语言' } });

		service.publishPageDraft.mockResolvedValueOnce({ kind: 'slug-taken' });
		const taken = await run('publish', { draftId: DRAFT_ID });
		expect(taken.status).toBe(400);
		expect((taken.data as { errors?: Record<string, string> }).errors?.slug).toBeTruthy();

		service.publishPageDraft.mockResolvedValueOnce({ kind: 'busy' });
		expect((await run('publish', { draftId: DRAFT_ID })).status).toBe(409);

		service.publishPageDraft.mockResolvedValueOnce({ kind: 'published', pageId: PAGE_ID });
		const ok = await run('publish', { draftId: DRAFT_ID });
		expect(ok.status).toBe(303);
		expect(ok.location).toBe(`/admin/pages/edit?id=${PAGE_ID}&published=1`);
	});

	it('routes discard redirects by placeholder state', async () => {
		service.discardPageDraft.mockResolvedValueOnce({
			kind: 'discarded',
			pageId: PAGE_ID,
			removedPlaceholder: true
		});
		expect((await run('discard', { draftId: DRAFT_ID })).location).toBe('/admin/pages?discarded=1');

		service.discardPageDraft.mockResolvedValueOnce({
			kind: 'discarded',
			pageId: PAGE_ID,
			removedPlaceholder: false
		});
		expect((await run('discard', { draftId: DRAFT_ID })).location).toBe(
			`/admin/pages/edit?id=${PAGE_ID}&discarded=1`
		);

		service.discardPageDraft.mockResolvedValueOnce({
			kind: 'discarded',
			pageId: null,
			removedPlaceholder: false
		});
		expect((await run('discard', { draftId: DRAFT_ID })).location).toBe('/admin/pages?discarded=1');

		service.discardPageDraft.mockResolvedValueOnce({ kind: 'busy' });
		expect((await run('discard', { draftId: DRAFT_ID })).status).toBe(409);
	});
});

describe('pages editor · load', () => {
	function loadEvent(id?: string) {
		return {
			url: new URL(`http://localhost/admin/pages/edit${id ? `?id=${id}` : ''}`),
			locals: { admin: { userId: 'user-1' }, user: { id: 'user-1' } }
		} as never;
	}

	beforeEach(() => {
		state.selectQueue = [];
		vi.clearAllMocks();
		Object.assign(dbMock, { select: vi.fn(() => selectChain()) });
	});

	it('loads a row for editing and exposes the draft payload + flags', async () => {
		state.selectQueue = [
			[
				{
					id: PAGE_ID,
					slug: 'draft-abc123',
					title: { en: 'Draft title' },
					description: null,
					icon: null,
					externalUrl: null,
					isDefault: false,
					status: 'hidden',
					content: null,
					updatedAt: new Date('2026-10-01T00:00:00Z')
				}
			]
		];
		service.loadPageDraftByPageId.mockResolvedValueOnce({
			id: DRAFT_ID,
			version: 2,
			slug: 'fresh-slug',
			payload: {
				title: { en: 'Draft title', 'zh-cn': '草稿' },
				description: null,
				content: { en: '# Body' }
			},
			updatedAt: new Date('2026-10-02T00:00:00Z')
		});

		const data = (await load(loadEvent(PAGE_ID))) as {
			page: Record<string, unknown>;
			draft: Record<string, unknown>;
			defaultLang: string;
		};
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.page).toMatchObject({
			placeholder: true,
			hasContent: false,
			editorMode: true,
			description: {}
		});
		expect(data.draft).toMatchObject({
			id: DRAFT_ID,
			version: 2,
			slug: 'fresh-slug',
			title: { en: 'Draft title', 'zh-cn': '草稿' },
			description: {},
			content: { en: '# Body' }
		});
		expect(data.defaultLang).toBe('en');
	});

	it('404s unknown ids and never asks the draft service for a missing row', async () => {
		state.selectQueue = [[]];
		await expect(load(loadEvent(PAGE_ID))).rejects.toMatchObject({ status: 404 });
		expect(service.loadPageDraftByPageId).not.toHaveBeenCalled();
	});

	it('answers new-mode (no id) with a virtual editor target (P5-3)', async () => {
		const data = (await load(loadEvent())) as {
			page: Record<string, unknown>;
			draft: unknown;
			defaultLang: string;
		};
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.page).toMatchObject({
			id: '',
			newPage: true,
			placeholder: true,
			hasContent: false,
			editorMode: true,
			status: 'hidden',
			isDefault: false,
			updatedAt: null
		});
		expect(data.draft).toBeNull();
		// The virtual target never touches the database or the draft service.
		expect(dbMock.select).not.toHaveBeenCalled();
		expect(service.loadPageDraftByPageId).not.toHaveBeenCalled();
		expect(data.defaultLang).toBe('en');
	});
});

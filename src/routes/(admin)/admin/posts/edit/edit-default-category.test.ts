import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the editor's default-category fallback (Task A2).
 *
 * `saveDraftWork` falls back to `categories.is_default`, so the load has to
 * hand the editor that id for the pre-selection, and both switches over the
 * save result have to turn `needs-default-category` into a 400 the editor can
 * act on instead of a generic failure. The db module is mocked with the same
 * recording chain as `draft-actions.test.ts`.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectQueue: [] as unknown[][] },
	service: {
		saveDraftWork: vi.fn(),
		publishDraft: vi.fn()
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/writer-lang', () => ({ resolveWriterLang: vi.fn(async () => 'en') }));
vi.mock('$lib/server/services/post-drafts', () => ({
	saveDraftWork: service.saveDraftWork,
	publishDraft: service.publishDraft,
	discardDraft: vi.fn(),
	createTranslationDraft: vi.fn(),
	loadDraftByPostId: vi.fn(async () => null),
	isPlaceholderSlug: vi.fn((slug: string) => slug.startsWith('draft-'))
}));
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: vi.fn() }));

import { actions, load } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions
// stay in sync with the zh-cn catalog (same convention as the sibling tests).
overwriteGetLocale(() => 'zh-cn');

const CAT_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_ID = '22222222-2222-2222-2222-222222222222';

const NO_DEFAULT_COPY = '尚无默认分类，请先初始化默认分类再保存';

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(resolve, reject)
	});
	return chain;
}

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/posts/edit', { method: 'POST', body }),
		locals: { admin: { userId: 'user-1', role: 'owner' } }
	};
}

async function callAction(name: string, fields: Record<string, string>) {
	const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
	const result = await fn(makeEvent(fields) as never);
	return result as { status?: number; data?: Record<string, unknown> };
}

async function runLoad() {
	const event = { url: new URL('http://x/admin/posts/edit'), locals: { user: null } };
	return (await load(event as never)) as unknown as {
		categories: { id: string }[];
		defaultCategoryId: string | null;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.selectQueue = [];
	dbMock.select = vi.fn(() => selectChain());
});

describe('editor load: default category', () => {
	it('exposes the flagged category so a new article can save', async () => {
		state.selectQueue = [[{ id: CAT_ID, name: 'Tech', slug: 'tech' }], [{ id: DEFAULT_ID }], []];

		const data = await runLoad();

		expect(data.categories).toHaveLength(1);
		expect(data.defaultCategoryId).toBe(DEFAULT_ID);
	});

	it('exposes null when no category is flagged', async () => {
		state.selectQueue = [[{ id: CAT_ID, name: 'Tech', slug: 'tech' }], [], []];

		const data = await runLoad();

		expect(data.defaultCategoryId).toBeNull();
	});
});

describe('editor actions: missing default category', () => {
	it('answers 400 with the pinned copy and the actionable flag', async () => {
		service.saveDraftWork.mockResolvedValue({ kind: 'needs-default-category' });

		const saved = await callAction('save', { title: 'x', categoryId: '' });
		expect(saved).toMatchObject({
			status: 400,
			data: { message: NO_DEFAULT_COPY, defaultCategoryMissing: true }
		});

		const published = await callAction('publish', { title: 'x', categoryId: '' });
		expect(published).toMatchObject({
			status: 400,
			data: { message: NO_DEFAULT_COPY, defaultCategoryMissing: true }
		});
		expect(service.publishDraft).not.toHaveBeenCalled();
		// Client contract (not asserted here - the logic lives in +page.svelte):
		// the editor turns this flag into `needs-default-category` + `scheduleStash()`,
		// exactly like `runSave`, so a first publish that fails keeps the typed body
		// in the local stash instead of losing it with the in-memory state.
	});
});

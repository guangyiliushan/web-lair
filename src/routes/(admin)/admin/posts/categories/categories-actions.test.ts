import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin categories actions (P2 review fixes).
 *
 * The actions now live on three modules because a form can only post to the
 * route that renders it, and the list is shared by both routes:
 *   +layout.server.ts  — the list load
 *   +page.server.ts    — create (list route)
 *   [id]/+page.server.ts — update / delete (record route, id from params)
 *
 * All of them put the admin guard FIRST (actions are not covered by layout
 * loads — Kit runs the action before its loads). Delete still counts posts,
 * pointing placeholder-only categories at the drafts page, with the FK as the
 * backstop for the count-then-delete race.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		counts: { total: 0, placeholders: 0 },
		inserted: [] as unknown[],
		deleted: 0,
		updated: 0,
		failWith: undefined as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { requireAdminRole } from '$lib/server/authz';
import { load as loadList } from './+layout.server';
import { actions as listActions } from './+page.server';
import { actions as recordActions, load as loadRecord } from './[id]/+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions
// stay in sync with the zh-cn catalog (same convention as the e2e fixtures
// that assert Chinese copy).
overwriteGetLocale(() => 'zh-cn');

const guardMock = vi.mocked(requireAdminRole);

const CAT_ID = '11111111-1111-1111-1111-111111111111';

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

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/posts/categories', { method: 'POST', body }) };
}

type ActionSource = Record<string, (event: never) => Promise<unknown>>;

async function callAction(
	source: ActionSource,
	name: string,
	fields: Record<string, string> = {},
	id = CAT_ID
) {
	try {
		const fn = source[name];
		const event = { ...makeEvent(fields), params: { id } };
		const result = await fn(event as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number; location?: string } };
	}
}

function resetDb() {
	Object.assign(dbMock, {
		select: vi.fn(() => makeChain([state.counts])),
		insert: vi.fn(() => ({
			values: () => ({
				returning: async () => [{ id: CAT_ID }]
			})
		})),
		update: vi.fn(() => ({
			set: () => ({
				where: async () => {
					state.updated += 1;
				}
			})
		})),
		delete: vi.fn(() => ({
			where: async () => {
				if (state.failWith) throw state.failWith;
				state.deleted += 1;
			}
		}))
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	state.counts = { total: 0, placeholders: 0 };
	state.inserted = [];
	state.deleted = 0;
	state.updated = 0;
	state.failWith = undefined;
	resetDb();
});

describe('categories list load', () => {
	it('guards the load and exposes the list with post counts', async () => {
		dbMock.select = vi
			.fn()
			.mockReturnValueOnce(makeChain([{ id: CAT_ID, name: 'Tech', slug: 'tech' }]))
			.mockReturnValueOnce(makeChain([{ categoryId: CAT_ID, count: 2 }]));

		const result = (await loadList({} as never)) as unknown as {
			categories: { id: string }[];
			postCounts: Record<string, number>;
		};

		expect(guardMock).toHaveBeenCalledTimes(1);
		expect(result.categories).toHaveLength(1);
		expect(result.postCounts).toEqual({ [CAT_ID]: 2 });
	});
});

describe('categories record load', () => {
	it('404s on a malformed id before touching the database', async () => {
		await expect(loadRecord({ params: { id: 'nope' } } as never)).rejects.toMatchObject({
			status: 404
		});
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('never promotes a destructive action to primary', async () => {
		// Two selects on this route: the record, then its related posts.
		dbMock.select = vi
			.fn()
			.mockReturnValueOnce(makeChain([{ id: CAT_ID, name: 'T', slug: 't' }]))
			.mockReturnValue(makeChain([]));
		const result = (await loadRecord({ params: { id: CAT_ID } } as never)) as unknown as {
			headerActions: { iconName: string; variant?: string; href?: string }[];
		};
		const destructive = result.headerActions.find((a) => a.iconName === 'trash');
		expect(destructive?.variant).not.toBe('default');
		expect(destructive?.href).toBeUndefined();
	});
});

describe('categories actions', () => {
	it('runs every action behind the admin guard first', async () => {
		await callAction(listActions as ActionSource, 'create');
		await callAction(recordActions as ActionSource, 'update');
		await callAction(recordActions as ActionSource, 'delete');
		expect(guardMock).toHaveBeenCalledTimes(3);
	});

	it('stops an action when the guard rejects (no db writes)', async () => {
		for (const [source, name] of [
			[listActions, 'create'],
			[recordActions, 'update'],
			[recordActions, 'delete']
		] as const) {
			guardMock.mockImplementationOnce(() => {
				throw Object.assign(new Error('redirect'), { status: 303, location: '/login' });
			});
			const { thrown } = await callAction(source as ActionSource, name, {
				name: 'X',
				slug: 'x'
			});
			expect(thrown?.status).toBe(303);
		}
		expect(state.inserted).toHaveLength(0);
		expect(state.deleted).toBe(0);
		expect(state.updated).toBe(0);
	});

	it('redirects to the new record after create', async () => {
		const { thrown } = await callAction(listActions as ActionSource, 'create', {
			name: 'Tech',
			slug: 'tech'
		});
		expect(thrown?.status).toBe(303);
		expect(thrown?.location).toBe(`/admin/posts/categories/${CAT_ID}`);
	});

	it('rejects a malformed route id on update and delete', async () => {
		expect(
			(await callAction(recordActions as ActionSource, 'update', { name: 'X' }, 'nope')).result
		).toMatchObject({ status: 400 });
		expect(
			(await callAction(recordActions as ActionSource, 'delete', {}, 'nope')).result
		).toMatchObject({ status: 400 });
		expect(state.deleted).toBe(0);
		expect(state.updated).toBe(0);
	});

	it('deletes an empty category', async () => {
		const { result } = await callAction(recordActions as ActionSource, 'delete');
		expect(result).toMatchObject({ success: true, deleted: CAT_ID });
		expect(state.deleted).toBe(1);
	});

	it('answers 409 with a drafts-page pointer when only placeholders block', async () => {
		state.counts = { total: 2, placeholders: 2 };
		const { result } = await callAction(recordActions as ActionSource, 'delete');
		expect(result).toMatchObject({
			status: 409,
			data: { error: expect.stringContaining('占位') }
		});
		expect(state.deleted).toBe(0);
	});

	it('answers 409 with the article count when real posts block', async () => {
		state.counts = { total: 3, placeholders: 1 };
		const { result } = await callAction(recordActions as ActionSource, 'delete');
		expect(result).toMatchObject({
			status: 409,
			data: { error: expect.stringContaining('仍有 3 篇') }
		});
		expect(state.deleted).toBe(0);
	});

	it('keeps the FK as the backstop for the count-then-delete race', async () => {
		state.failWith = Object.assign(new Error('fk'), { cause: { code: '23503' } });
		const { result } = await callAction(recordActions as ActionSource, 'delete');
		expect(result).toMatchObject({ status: 409, data: { error: expect.any(String) } });
	});
});

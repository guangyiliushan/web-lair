import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin categories actions (P2 review fixes):
 * create/update/delete sit behind the admin guard as their FIRST statement
 * (actions are not covered by layout loads - Kit runs the action before its
 * loads), and the delete guard counts posts, pointing placeholder-only
 * categories at the drafts page while keeping the FK as the backstop.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		counts: { total: 0, placeholders: 0 },
		inserted: [] as unknown[],
		deleted: 0,
		failWith: undefined as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { requireAdminRole } from '$lib/server/authz';
import { actions } from './+page.server';

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

async function callAction(name: string, fields: Record<string, string>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = await fn(makeEvent(fields) as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number; location?: string } };
	}
}

describe('categories actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.counts = { total: 0, placeholders: 0 };
		state.inserted = [];
		state.deleted = 0;
		state.failWith = undefined;
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain([state.counts])),
			insert: vi.fn(() => ({
				values: async (values: unknown) => {
					state.inserted.push(values);
				}
			})),
			update: vi.fn(() => ({
				set: () => ({ where: async () => undefined })
			})),
			delete: vi.fn(() => ({
				where: async () => {
					if (state.failWith) throw state.failWith;
					state.deleted += 1;
				}
			}))
		});
	});

	it('runs every action behind the admin guard first', async () => {
		await callAction('create', {});
		await callAction('update', {});
		await callAction('delete', {});
		expect(guardMock).toHaveBeenCalledTimes(3);
	});

	it('stops an action when the guard rejects (no db writes)', async () => {
		for (const name of ['create', 'update', 'delete']) {
			guardMock.mockImplementationOnce(() => {
				throw Object.assign(new Error('redirect'), { status: 303, location: '/login' });
			});
			const { thrown } = await callAction(name, {
				id: CAT_ID,
				name: 'X',
				slug: 'x'
			});
			expect(thrown?.status).toBe(303);
		}
		expect(state.inserted).toHaveLength(0);
		expect(state.deleted).toBe(0);
	});

	it('rejects a malformed id on update and delete', async () => {
		expect((await callAction('update', { id: 'nope', name: 'X' })).result).toMatchObject({
			status: 400
		});
		expect((await callAction('delete', { id: 'nope' })).result).toMatchObject({ status: 400 });
		expect(state.deleted).toBe(0);
	});

	it('deletes an empty category', async () => {
		const { result } = await callAction('delete', { id: CAT_ID });
		expect(result).toMatchObject({ success: true });
		expect(state.deleted).toBe(1);
	});

	it('answers 409 with a drafts-page pointer when only placeholders block', async () => {
		state.counts = { total: 2, placeholders: 2 };
		const { result } = await callAction('delete', { id: CAT_ID });
		expect(result).toMatchObject({
			status: 409,
			data: { error: expect.stringContaining('占位') }
		});
		expect(state.deleted).toBe(0);
	});

	it('answers 409 with the article count when real posts block', async () => {
		state.counts = { total: 3, placeholders: 1 };
		const { result } = await callAction('delete', { id: CAT_ID });
		expect(result).toMatchObject({
			status: 409,
			data: { error: expect.stringContaining('仍有 3 篇') }
		});
		expect(state.deleted).toBe(0);
	});

	it('keeps the FK as the backstop for the count-then-delete race', async () => {
		state.failWith = Object.assign(new Error('fk'), { cause: { code: '23503' } });
		const { result } = await callAction('delete', { id: CAT_ID });
		expect(result).toMatchObject({ status: 409, data: { error: expect.any(String) } });
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the reader (better-auth user) actions.
 *
 * Readers differ from the taxonomy routes: their public id is a text key, not
 * a uuid, and the one action that can lock the site out of its own admin —
 * ownership transfer — is deliberately not implemented here.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		updated: 0,
		lastSet: undefined as Record<string, unknown> | undefined
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { requireAdminRole } from '$lib/server/authz';
import { actions, load } from './[id]/+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

const guardMock = vi.mocked(requireAdminRole);

const OWNER_ID = 'owner-1';
const READER_ID = 'reader-1';

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

type ActionSource = Record<string, (event: never) => Promise<unknown>>;

async function callAction(name: string, id: string, fields: Record<string, string> = {}) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const event = {
		request: new Request('http://x/admin/readers', { method: 'POST', body }),
		params: { id }
	};
	try {
		const result = await (actions as ActionSource)[name](event as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number } };
	}
}

function resetDb() {
	state.selectQueue = [];
	state.updated = 0;
	state.lastSet = undefined;
	Object.assign(dbMock, {
		select: vi.fn(() => makeChain(state.selectQueue.shift() ?? [])),
		update: vi.fn(() => ({
			set: (set: Record<string, unknown>) => ({
				where: () => {
					state.updated += 1;
					state.lastSet = set;
					return { returning: async () => [{ id: READER_ID }] };
				}
			})
		}))
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetDb();
});

describe('readers record load', () => {
	it('404s when no user matches the id', async () => {
		state.selectQueue = [[]];
		await expect(load({ params: { id: 'nope' } } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('offers lift-ban instead of ban when already banned, and never as primary', async () => {
		state.selectQueue = [
			[{ id: READER_ID, name: 'R', email: 'r@x', role: 'reader', banned: true, banReason: 'x' }],
			[]
		];
		const result = (await load({ params: { id: READER_ID } } as never)) as unknown as {
			headerActions: { label: string; variant?: string; actionId?: string }[];
		};
		expect(result.headerActions.map((a) => a.actionId)).toContain('readers:unban');
		const destructive = result.headerActions.find((a) => a.actionId?.startsWith('readers:'));
		expect(destructive?.variant).not.toBe('default');
	});
});

describe('readers actions', () => {
	it('runs every action behind the admin guard first', async () => {
		state.selectQueue = [[{ role: 'reader' }], [{ role: 'reader' }], []];
		await callAction('ban', READER_ID);
		await callAction('unban', READER_ID);
		await callAction('transfer', OWNER_ID);
		expect(guardMock).toHaveBeenCalledTimes(3);
	});

	it('refuses to ban the owner — that would lock the site out', async () => {
		state.selectQueue = [[{ role: 'owner' }]];
		const { result } = await callAction('ban', OWNER_ID);
		expect(result).toMatchObject({ status: 409 });
		expect(state.updated).toBe(0);
	});

	it('bans a reader and records the reason', async () => {
		state.selectQueue = [[{ role: 'reader' }]];
		const { result } = await callAction('ban', READER_ID, { reason: 'spam' });
		expect(result).toMatchObject({ success: true });
		expect(state.lastSet).toEqual({ banned: true, banReason: 'spam' });
	});

	it('lifts a ban and clears the reason and expiry', async () => {
		const { result } = await callAction('unban', READER_ID);
		expect(result).toMatchObject({ success: true });
		expect(state.lastSet).toEqual({ banned: false, banReason: null, banExpires: null });
	});

	it('reports ownership transfer as unavailable rather than half-doing it', async () => {
		const { result } = await callAction('transfer', OWNER_ID);
		expect(result).toMatchObject({ status: 501 });
		expect(state.updated).toBe(0);
	});
});

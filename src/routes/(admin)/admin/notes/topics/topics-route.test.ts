import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Route-level tests for topics CRUD (batch 5): validation guards, unique-
 * violation discrimination (23505 → 409, everything else rethrows), the
 * deterministic renumber transaction behind ▲/▼, and the delete attribution
 * check (the FK is SET NULL, so the refusal must be application-level).
 */
const { dbMock, state, pg } = vi.hoisted(() => {
	const dbMock: Record<string, unknown> = {};
	const state = {
		selectQueue: [] as unknown[][],
		updateResults: [] as unknown[][],
		inserts: [] as { values: Record<string, unknown> }[],
		updates: [] as { values: Record<string, unknown> }[],
		updateWheres: [] as unknown[],
		deletes: [] as unknown[],
		transactions: 0,
		failWith: null as null | { code?: string }
	};
	const pg = { pgErrorCode: vi.fn((error: unknown) => (error as { code?: string })?.code ?? null) };
	return { dbMock, state, pg };
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn() }));
vi.mock('$lib/server/db/pg-error', () => ({ pgErrorCode: pg.pgErrorCode }));

import { actions } from './+page.server';

const TOPIC_ID = '44444444-4444-4444-4444-444444444444';

function selectChain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		groupBy: ret,
		// The delete flow locks the topic row (`for('update')`).
		for: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

function makeWriteExecutors() {
	return {
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				if (state.failWith) throw Object.assign(new Error('db'), state.failWith);
				state.inserts.push({ values });
				return Promise.resolve();
			}
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: (cond?: unknown) => {
					if (state.failWith) throw Object.assign(new Error('db'), state.failWith);
					state.updates.push({ values });
					state.updateWheres.push(cond);
					// `.returning()` (update action) consumes a queued result;
					// awaiting the chain directly (move renumber) does not.
					return {
						returning: async () => state.updateResults.shift() ?? [],
						then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res)
					};
				}
			})
		}),
		delete: () => ({
			where: () => {
				state.deletes.push({});
				return Promise.resolve();
			}
		}),
		select: selectChain
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.selectQueue = [];
	state.updateResults = [];
	state.inserts = [];
	state.updates = [];
	state.updateWheres = [];
	state.deletes = [];
	state.transactions = 0;
	state.failWith = null;
	Object.assign(dbMock, {
		...makeWriteExecutors(),
		transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
			state.transactions += 1;
			return cb(makeWriteExecutors());
		})
	});
});

type ActionEvent = Parameters<typeof actions.create>[0];

function event(fields: Record<string, string>): ActionEvent {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) fd.set(key, value);
	return {
		request: new Request('http://localhost/admin/notes/topics', { method: 'POST', body: fd })
	} as unknown as ActionEvent;
}

type Outcome = { status: number; data?: Record<string, unknown>; thrown?: unknown };

async function run(name: keyof typeof actions, fields: Record<string, string>): Promise<Outcome> {
	try {
		const result = (await actions[name]!(event(fields))) as {
			status?: number;
			data?: Record<string, unknown>;
		};
		return { status: result?.status ?? 200, data: result?.data };
	} catch (thrown) {
		const response = thrown as { status?: number; location?: string };
		if (response && typeof response === 'object' && 'location' in response) {
			return { status: response.status ?? 500 };
		}
		return { status: -1, thrown };
	}
}

describe('topics · create', () => {
	it('requires name and slug', async () => {
		expect((await run('create', { name: ' ', slug: 'x' })).status).toBe(400);
		expect((await run('create', { name: '旅行', slug: ' ' })).status).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});

	it('rejects icons outside the shared whitelist (front end never renders them)', async () => {
		expect(
			(await run('create', { name: '旅行', slug: 'travel', icon: 'totally-fake' })).status
		).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});

	it('normalizes values and defaults sortOrder to 0', async () => {
		const result = await run('create', {
			name: '  旅行  ',
			slug: 'Travel',
			description: '  笔记  ',
			icon: '',
			sortOrder: 'abc'
		});
		expect(result.status).toBe(200);
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].values).toEqual({
			name: '旅行',
			slug: 'travel',
			description: '笔记',
			icon: null,
			sortOrder: 0
		});
	});

	it('maps only 23505 to a 409 conflict, and rethrows everything else', async () => {
		state.failWith = { code: '23505' };
		const conflict = await run('create', { name: '旅行', slug: 'travel' });
		expect(conflict.status).toBe(409);
		expect((conflict.data as { error?: string }).error).toContain('已存在');

		state.failWith = { code: '08006' };
		const thrown = await run('create', { name: '旅行', slug: 'travel' });
		// Connection failures must not masquerade as "slug taken".
		expect(thrown.status).toBe(-1);
		expect(thrown.thrown).toBeInstanceOf(Error);
	});
});

describe('topics · update / delete', () => {
	it('update validates the id, reflects set values and reports a vanished row', async () => {
		expect((await run('update', { id: 'nope', name: '旅行', slug: 'travel' })).status).toBe(400);
		expect(
			(await run('update', { id: TOPIC_ID, name: '旅行', slug: 'travel', icon: 'totally-fake' }))
				.status
		).toBe(400);

		state.updateResults = [[{ id: TOPIC_ID }]];
		const result = await run('update', {
			id: TOPIC_ID,
			name: '旅行',
			slug: 'travel',
			description: '',
			icon: 'plane',
			sortOrder: '3'
		});
		expect(result.status).toBe(200);
		expect(state.updates[0].values).toEqual({
			name: '旅行',
			slug: 'travel',
			description: '',
			icon: 'plane',
			sortOrder: 3
		});

		// 0 rows affected: not-found must not answer success.
		state.updateResults = [[]];
		expect((await run('update', { id: TOPIC_ID, name: '旅行', slug: 'travel' })).status).toBe(404);
	});

	it('delete refuses while notes still attribute to the topic', async () => {
		// The flow locks the topic row, then counts: [topic, count].
		state.selectQueue = [[{ id: TOPIC_ID }], [{ total: 3 }]];
		const refused = await run('delete', { id: TOPIC_ID });
		expect(refused.status).toBe(409);
		expect((refused.data as { error?: string }).error).toContain('3 篇手记');
		expect(state.deletes).toHaveLength(0);

		state.selectQueue = [[{ id: TOPIC_ID }], [{ total: 0 }]];
		const removed = await run('delete', { id: TOPIC_ID });
		expect(removed.status).toBe(200);
		expect(state.deletes).toHaveLength(1);
		expect(state.transactions).toBe(2);

		// A vanished topic answers 404, not success.
		state.selectQueue = [[]];
		expect((await run('delete', { id: TOPIC_ID })).status).toBe(404);
	});
});

describe('topics · move (▲/▼)', () => {
	it('rejects bad direction and reports missing rows', async () => {
		expect((await run('move', { id: TOPIC_ID, direction: 'left' })).status).toBe(400);

		state.selectQueue = [[]];
		expect((await run('move', { id: TOPIC_ID, direction: 'up' })).status).toBe(404);
	});

	it('is a no-op at the edges', async () => {
		state.selectQueue = [[{ id: TOPIC_ID }, { id: 'other' }]];
		const result = await run('move', { id: TOPIC_ID, direction: 'up' });
		expect(result.status).toBe(200);
		expect(state.updates).toHaveLength(0);
	});

	it('swaps and renumbers the whole list in one transaction', async () => {
		const ids = ['a', 'b', 'c'].map(
			(tail) => `00000000-0000-0000-0000-00000000000${idsTail(tail)}`
		);
		state.selectQueue = [ids.map((id) => ({ id }))];
		const result = await run('move', { id: ids[1], direction: 'up' });
		expect(result.status).toBe(200);
		expect(state.transactions).toBe(1);
		// b⇄a then c: every position is rewritten (deterministic renumber).
		expect(state.updates.map((u) => u.values.sortOrder)).toEqual([0, 1, 2]);
		// The swap itself is pinned: the first renumbered row must be b.
		const dialect = new PgDialect();
		const updatedIds = state.updateWheres.map((cond) => dialect.sqlToQuery(cond as SQL).params[0]);
		expect(updatedIds).toEqual([ids[1], ids[0], ids[2]]);
	});

	function idsTail(tail: string): number {
		return { a: 1, b: 2, c: 3 }[tail] ?? 0;
	}
});

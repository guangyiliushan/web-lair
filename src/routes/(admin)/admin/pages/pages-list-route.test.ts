import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the P2 pages admin (T6 unit side): the chrome order +
 * locale-fallback title in load, the ▲/▼ swap as a full renumber inside one
 * locked transaction, the cross-group/edge no-ops, the status whitelist, the
 * delete guards (uuid / default protection / locked re-check) and the
 * guard-order binding. The db module is mocked with a recording chain so a
 * dropped WHERE, a dropped lock, a wrong order or an unprotected default
 * turns red.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		orderArgs: [] as unknown[][],
		executes: [] as { sql: string; params: unknown[] }[],
		statusUpdates: [] as { values: Record<string, unknown>; target: string }[],
		forCalls: [] as unknown[],
		deletes: [] as unknown[]
	},
	service: { requireAdminRole: vi.fn() }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja']
}));

import { actions, load } from './+page.server';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_A = '22222222-2222-2222-2222-222222222222';
const OTHER_B = '33333333-3333-3333-3333-333333333333';
const dialect = new PgDialect();

function formEvent(entries: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(entries)) body.set(key, value);
	return { request: new Request('http://localhost/admin/pages', { method: 'POST', body }) };
}

function selectChain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: ret,
		limit: ret,
		for: (...args: unknown[]) => {
			state.forCalls.push(args[0]);
			return c;
		},
		orderBy: (...args: unknown[]) => {
			state.orderArgs.push(args);
			return c;
		},
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

function makeTx(): Record<string, unknown> {
	const c = selectChain();
	Object.assign(c, {
		select: () => c,
		execute: async (query: unknown) => {
			const rendered = dialect.sqlToQuery(query as never);
			state.executes.push({ sql: rendered.sql, params: rendered.params });
		},
		delete: () => ({
			where: async (cond: unknown) => {
				state.deletes.push(cond);
			}
		})
	});
	return c;
}

describe('admin pages list (P2)', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.returningQueue = [];
		state.orderArgs = [];
		state.executes = [];
		state.statusUpdates = [];
		state.forCalls = [];
		state.deletes = [];
		service.requireAdminRole.mockClear();
		Object.assign(dbMock, {
			select: vi.fn(() => selectChain()),
			update: vi.fn(() => ({
				set: vi.fn((values: Record<string, unknown>) => ({
					where: vi.fn((cond: unknown) => {
						const params = dialect.sqlToQuery(cond as never).params;
						state.statusUpdates.push({ values, target: String(params[0]) });
						return { returning: vi.fn(async () => state.returningQueue.shift() ?? []) };
					})
				}))
			})),
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()))
		});
	});

	it('lists rows in chrome order with the locale fallback title', async () => {
		state.selectQueue = [
			[
				{
					id: PAGE_ID,
					slug: 'about',
					title: { 'zh-cn': '关于我' },
					externalUrl: null,
					status: 'visible',
					sortOrder: 1,
					isDefault: true,
					hasContent: true,
					updatedAt: new Date('2026-10-01T00:00:00Z')
				}
			]
		];

		const data = (await load({} as never)) as { pages: { title: string }[] };

		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.pages[0].title).toBe('关于我');
		const fragments = state.orderArgs[0].map((arg) => dialect.sqlToQuery(sql`${arg}`).sql);
		const orderSql = fragments.join(' | ');
		// Relative order and per-key directions, not mere token presence.
		expect(orderSql.indexOf('"pages"."is_default"')).toBeLessThan(
			orderSql.indexOf('"pages"."sort_order"')
		);
		expect(orderSql.indexOf('"pages"."sort_order"')).toBeLessThan(
			orderSql.indexOf('"pages"."created_at"')
		);
		expect(fragments[0].toLowerCase()).toContain('desc');
		expect(fragments[1].toLowerCase()).toContain('asc');
		expect(fragments[2].toLowerCase()).toContain('asc');
	});

	it('reorders with a full renumber inside one locked transaction (swap pinned)', async () => {
		state.selectQueue = [
			[
				{ id: OTHER_A, isDefault: false },
				{ id: PAGE_ID, isDefault: false },
				{ id: OTHER_B, isDefault: false }
			]
		];

		const result = await actions.move!(formEvent({ id: PAGE_ID, direction: 'down' }) as never);

		expect(result).toEqual({ success: true });
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
		// The renumber runs on the locking read, in the chrome order.
		expect(state.forCalls).toContain('update');
		const moveOrder = state.orderArgs[0]
			.map((arg) => dialect.sqlToQuery(sql`${arg}`).sql)
			.join(' | ');
		expect(moveOrder.indexOf('"pages"."is_default"')).toBeLessThan(
			moveOrder.indexOf('"pages"."sort_order"')
		);
		// Raw-SQL renumber: [sort_order, id] pairs, position = array index.
		expect(state.executes.map((entry) => [entry.params[1], entry.params[0]])).toEqual([
			[OTHER_A, 0],
			[OTHER_B, 1],
			[PAGE_ID, 2]
		]);
		expect(state.executes[0].sql).toContain('update pages set sort_order');
	});

	it('guards the move input and reports missing rows', async () => {
		expect(await actions.move!(formEvent({ id: 'nope', direction: 'up' }) as never)).toMatchObject({
			status: 400
		});
		expect(service.requireAdminRole).toHaveBeenCalled();

		expect(
			await actions.move!(formEvent({ id: PAGE_ID, direction: 'sideways' }) as never)
		).toMatchObject({ status: 400 });

		state.selectQueue = [[{ id: OTHER_A, isDefault: false }]];
		expect(await actions.move!(formEvent({ id: PAGE_ID, direction: 'up' }) as never)).toMatchObject(
			{ status: 404 }
		);
	});

	it('treats edge moves as no-op successes without writing', async () => {
		state.selectQueue = [[{ id: PAGE_ID, isDefault: false }]];

		const top = await actions.move!(formEvent({ id: PAGE_ID, direction: 'up' }) as never);
		expect(top).toEqual({ success: true });
		expect(state.executes).toHaveLength(0);

		state.selectQueue = [
			[
				{ id: OTHER_A, isDefault: false },
				{ id: PAGE_ID, isDefault: false }
			]
		];
		const bottom = await actions.move!(formEvent({ id: PAGE_ID, direction: 'down' }) as never);
		expect(bottom).toEqual({ success: true });
		expect(state.executes).toHaveLength(0);
	});

	it('treats a cross-group move as a no-op without writing', async () => {
		state.selectQueue = [
			[
				{ id: OTHER_A, isDefault: true },
				{ id: PAGE_ID, isDefault: false }
			]
		];

		const result = await actions.move!(formEvent({ id: PAGE_ID, direction: 'up' }) as never);

		expect(result).toEqual({ success: true });
		expect(state.executes).toHaveLength(0);
	});

	it('validates the status whitelist, the id shape and reports missing rows', async () => {
		expect(
			await actions.setStatus!(formEvent({ id: 'nope', status: 'hidden' }) as never)
		).toMatchObject({ status: 400 });

		expect(
			await actions.setStatus!(formEvent({ id: PAGE_ID, status: 'gone' }) as never)
		).toMatchObject({ status: 400 });

		state.returningQueue = [[]];
		expect(
			await actions.setStatus!(formEvent({ id: PAGE_ID, status: 'hidden' }) as never)
		).toMatchObject({ status: 404 });

		state.returningQueue = [[{ id: PAGE_ID }]];
		expect(await actions.setStatus!(formEvent({ id: PAGE_ID, status: 'hidden' }) as never)).toEqual(
			{ success: true }
		);
		// Both writes are pinned to the id and the requested status.
		expect(state.statusUpdates.map((entry) => [entry.target, entry.values.status])).toEqual([
			[PAGE_ID, 'hidden'],
			[PAGE_ID, 'hidden']
		]);
	});

	it('protects default rows and deletes only after a locked re-check', async () => {
		// Deleting requires the guard and a well-formed id.
		expect(await actions.delete!(formEvent({ id: 'nope' }) as never)).toMatchObject({
			status: 400
		});

		// The whole guard runs INSIDE the transaction: the outer handle is
		// never used (moving the check out of the tx would throw right here).
		dbMock.select = vi.fn(() => {
			throw new Error('outer select must not run for delete');
		});

		state.selectQueue = [[{ id: PAGE_ID, isDefault: true }]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 409
		});
		expect(state.deletes).toHaveLength(0);
		expect(state.forCalls).toContain('update');

		state.selectQueue = [[{ id: PAGE_ID, isDefault: false }]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toEqual({
			success: true
		});
		expect(state.deletes).toHaveLength(1);
		expect(dialect.sqlToQuery(state.deletes[0] as never).params).toEqual([PAGE_ID]);
		expect(dbMock.transaction).toHaveBeenCalled();

		state.selectQueue = [[]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 404
		});
	});
});

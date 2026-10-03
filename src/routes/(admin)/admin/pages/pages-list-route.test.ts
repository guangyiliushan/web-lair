import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the P2 pages admin (T6 unit side): the chrome order +
 * locale-fallback title in load, the ▲/▼ swap as a full renumber inside one
 * transaction, the status whitelist, and the delete guards (uuid / default
 * protection / locked re-check). The db module is mocked with a recording
 * chain so a dropped WHERE, a wrong order or an unprotected default turns red.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		orderArgs: [] as unknown[][],
		updates: [] as { values: Record<string, unknown>; target: string }[],
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
		for: ret,
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
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: (cond: unknown) => {
					const params = dialect.sqlToQuery(cond as never).params;
					state.updates.push({ values, target: String(params[0]) });
					return Promise.resolve(undefined);
				}
			})
		}),
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
		state.updates = [];
		state.deletes = [];
		service.requireAdminRole.mockClear();
		Object.assign(dbMock, {
			select: vi.fn(() => selectChain()),
			update: vi.fn(() => ({
				set: vi.fn(() => ({
					where: vi.fn(() => ({
						returning: vi.fn(async () => state.returningQueue.shift() ?? [])
					}))
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
		const orderSql = state.orderArgs[0]
			.map((arg) => dialect.sqlToQuery(sql`${arg}`).sql)
			.join(' | ');
		expect(orderSql).toContain('"pages"."is_default"');
		expect(orderSql.toLowerCase()).toContain('desc');
		expect(orderSql).toContain('"pages"."sort_order"');
		expect(orderSql).toContain('"pages"."created_at"');
	});

	it('reorders with a full renumber inside one transaction (swap pinned)', async () => {
		state.selectQueue = [[{ id: OTHER_A }, { id: PAGE_ID }, { id: OTHER_B }]];

		const result = await actions.move!(formEvent({ id: PAGE_ID, direction: 'down' }) as never);

		expect(result).toEqual({ success: true });
		expect(state.updates.map((entry) => [entry.target, entry.values.sortOrder])).toEqual([
			[OTHER_A, 0],
			[OTHER_B, 1],
			[PAGE_ID, 2]
		]);
	});

	it('guards the move input and reports missing rows', async () => {
		expect(await actions.move!(formEvent({ id: 'nope', direction: 'up' }) as never)).toMatchObject({
			status: 400
		});
		expect(
			await actions.move!(formEvent({ id: PAGE_ID, direction: 'sideways' }) as never)
		).toMatchObject({ status: 400 });

		state.selectQueue = [[{ id: OTHER_A }]];
		expect(await actions.move!(formEvent({ id: PAGE_ID, direction: 'up' }) as never)).toMatchObject(
			{ status: 404 }
		);
	});

	it('treats an edge move as a no-op success', async () => {
		state.selectQueue = [[{ id: PAGE_ID }]];

		const result = await actions.move!(formEvent({ id: PAGE_ID, direction: 'up' }) as never);

		expect(result).toEqual({ success: true });
		expect(state.updates).toHaveLength(0);
	});

	it('validates the status whitelist and reports missing rows', async () => {
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
	});

	it('protects default rows and deletes only after a locked re-check', async () => {
		state.selectQueue = [[{ id: PAGE_ID, isDefault: true }]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 409
		});
		expect(state.deletes).toHaveLength(0);

		state.selectQueue = [[{ id: PAGE_ID, isDefault: false }]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toEqual({
			success: true
		});
		expect(state.deletes).toHaveLength(1);

		state.selectQueue = [[]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 404
		});
	});
});

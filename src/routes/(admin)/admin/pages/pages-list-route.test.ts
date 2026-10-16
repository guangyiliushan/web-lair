import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drafts, pages } from '$lib/server/db/content';

/**
 * Route-level tests for the P2 pages admin (T6 unit side) and the P5-3
 * create action: the chrome order + locale-fallback title in load, the ▲/▼
 * swap as a full renumber inside one locked transaction, the cross-group/edge
 * no-ops, the status whitelist, the delete guards (uuid / default protection /
 * locked re-check), the guard-order binding, and the direct external-entry
 * insert (no draft). The db module is mocked with a recording chain so a
 * dropped WHERE, a dropped lock, a wrong order, an unprotected default or an
 * unvalidated create turns red.
 */
const { dbMock, draftsForPagesMock, state, service, syncCheck } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	draftsForPagesMock: vi.fn(),
	syncCheck: vi.fn(async () => {}),
	state: {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		orderArgs: [] as unknown[][],
		executes: [] as { sql: string; params: unknown[] }[],
		statusUpdates: [] as { values: Record<string, unknown>; target: string }[],
		forCalls: [] as unknown[],
		deletes: [] as { table?: unknown; cond: unknown }[],
		deleteResults: [] as unknown[][],
		deleteThrow: null as unknown,
		inserts: [] as { values: Record<string, unknown> }[],
		nextThrow: null as unknown,
		tx: null as unknown
	},
	service: { requireAdminRole: vi.fn() }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
// The reference cleanup runs inside the delete transaction; its own teeth
// live in file-references.test.ts - here we pin that a hard delete calls it.
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: syncCheck }));
// The draft- prefix guard for「新增」外链 (P5-3) lives in the draft service;
// its own teeth live in page-drafts.test.ts.
vi.mock('$lib/server/services/page-drafts', () => ({
	isPagePlaceholderSlug: (slug: string) => slug.startsWith('draft-'),
	draftsForPages: draftsForPagesMock
}));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja'],
	experimentalStaticLocale: undefined
}));

import { actions, load } from './+page.server';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
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
		// Supports both `await tx.delete(t).where(...)` and the R2-3 cascade
		// shape `...where(...).returning({ id })`; rows come from the
		// deleteResults queue, one entry per delete call. `deleteThrow`
		// injects a failure (e.g. a 40P01-shaped error) for the busy mapping.
		delete: (table: unknown) => ({
			where: (cond: unknown) => {
				state.deletes.push({ table, cond });
				if (state.deleteThrow) {
					const thrown = state.deleteThrow;
					state.deleteThrow = null;
					throw thrown;
				}
				const rows = state.deleteResults.shift() ?? [];
				return Object.assign(Promise.resolve(rows), { returning: async () => rows });
			}
		})
	});
	return c;
}

// Shared harness reset (P5-5 T15/P1): the hoisted mock is module-level
// state both describes share - ONE beforeEach at the top level instead of
// two near-identical copies that can drift (the T6 review's point).
beforeEach(() => {
	state.selectQueue = [];
	state.returningQueue = [];
	state.orderArgs = [];
	state.executes = [];
	state.statusUpdates = [];
	state.forCalls = [];
	state.deletes = [];
	state.deleteResults = [];
	state.deleteThrow = null;
	state.inserts = [];
	state.nextThrow = null;
	state.tx = null;
	service.requireAdminRole.mockClear();
	syncCheck.mockClear();
	draftsForPagesMock.mockReset();
	draftsForPagesMock.mockResolvedValue(new Set());
	Object.assign(dbMock, {
		select: vi.fn(() => selectChain()),
		insert: vi.fn(() => ({
			values: vi.fn((values: Record<string, unknown>) => {
				state.inserts.push({ values });
				return {
					returning: vi.fn(async () => {
						if (state.nextThrow) {
							const thrown = state.nextThrow;
							state.nextThrow = null;
							throw thrown;
						}
						return state.returningQueue.shift() ?? [];
					})
				};
			})
		})),
		update: vi.fn(() => ({
			set: vi.fn((values: Record<string, unknown>) => ({
				where: vi.fn((cond: unknown) => {
					const params = dialect.sqlToQuery(cond as never).params;
					state.statusUpdates.push({ values, target: String(params[0]) });
					return { returning: vi.fn(async () => state.returningQueue.shift() ?? []) };
				})
			}))
		})),
		transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
			state.tx = makeTx();
			return cb(state.tx);
		})
	});
});

describe('admin pages list (P2)', () => {
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

		const data = (await load({} as never)) as { pages: { title: string; hasDraft: boolean }[] };

		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.pages[0].title).toBe('关于我');
		// The FALSE direction too (four-review #1: `hasDraft: true` used to
		// survive the suite - the badge would have been always-on).
		expect(data.pages[0].hasDraft).toBe(false);
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

	it('marks rows that carry a pending draft (T11)', async () => {
		state.selectQueue = [
			[
				{
					id: PAGE_ID,
					slug: 'about',
					title: { en: 'About' },
					externalUrl: null,
					status: 'visible',
					sortOrder: 1,
					isDefault: false,
					hasContent: true,
					updatedAt: new Date('2026-10-01T00:00:00Z')
				}
			]
		];
		draftsForPagesMock.mockResolvedValueOnce(new Set([PAGE_ID]));

		const data = (await load({} as never)) as { pages: { hasDraft: boolean }[] };

		expect(data.pages[0].hasDraft).toBe(true);
		// The service receives exactly the rendered row ids.
		expect(draftsForPagesMock).toHaveBeenCalledWith([PAGE_ID]);
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
		state.deleteResults = [[{ id: DRAFT_ID }], []];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toEqual({
			success: true
		});
		// Drafts go first (R2-3 review: drafts → files lock order), then the
		// page: both deletes recorded in that order.
		expect(state.deletes).toHaveLength(2);
		expect(state.deletes[0].table).toBe(drafts);
		expect(dialect.sqlToQuery(state.deletes[0].cond as never).params).toEqual(['page', PAGE_ID]);
		expect(state.deletes[1].table).toBe(pages);
		expect(dialect.sqlToQuery(state.deletes[1].cond as never).params).toEqual([PAGE_ID]);
		expect(dbMock.transaction).toHaveBeenCalled();
		// Q15 deletion hooks: the cascaded draft's references AND the page's
		// are cleared inside the same transaction, in order.
		expect(syncCheck).toHaveBeenCalledTimes(2);
		expect(syncCheck).toHaveBeenNthCalledWith(1, state.tx, { type: 'draft', id: DRAFT_ID }, []);
		expect(syncCheck).toHaveBeenNthCalledWith(2, state.tx, { type: 'page', id: PAGE_ID }, []);
		expect((syncCheck.mock.calls[0] as unknown[])[0]).toBe(state.tx);

		state.selectQueue = [[]];
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 404
		});
	});

	it('maps a deadlock / serialization failure to 409 busy (R2-3)', async () => {
		state.selectQueue = [[{ id: PAGE_ID, isDefault: false }]];
		state.deleteThrow = Object.assign(new Error('deadlock detected'), { code: '40P01' });
		expect(await actions.delete!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 409
		});
	});
});

describe('admin pages list · create external entry (P5-3)', () => {
	// The shared top-level beforeEach resets the whole harness (P5-5 T15/P1).

	it('inserts a direct external row after the validation chain (no draft)', async () => {
		state.returningQueue = [[{ id: PAGE_ID }]];
		const result = await actions.create!(
			formEvent({
				'title_zh-cn': ' 买杯咖啡 ',
				slug: ' Buy-Me-a-Coffee ',
				icon: 'coffee',
				externalUrl: ' https://ko-fi.example/me ',
				description_en: ' Thanks '
			}) as never
		);
		expect(result).toMatchObject({ success: true, id: PAGE_ID });
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].values).toEqual({
			title: { 'zh-cn': '买杯咖啡' },
			description: { en: 'Thanks' },
			icon: 'coffee',
			externalUrl: 'https://ko-fi.example/me',
			slug: 'buy-me-a-coffee',
			status: 'visible',
			contentFormat: 'markdown'
		});
	});

	it('rejects every invalid create payload before touching the insert', async () => {
		const cases: Record<string, string>[] = [
			{ title_en: '  ', slug: 'x', externalUrl: 'https://x.example' }, // title
			{ title_en: 'X', slug: '', externalUrl: 'https://x.example' }, // slug required
			// 'bad_Slug' lowercases to 'bad_slug'; the underscore still fails the charset.
			{ title_en: 'X', slug: 'bad_Slug', externalUrl: 'https://x.example' }, // slug charset
			{ title_en: 'X', slug: 'admin', externalUrl: 'https://x.example' }, // reserved
			{ title_en: 'X', slug: 'draft-taken', externalUrl: 'https://x.example' }, // draft- prefix
			{ title_en: 'X', slug: 'ok', icon: 'evil', externalUrl: 'https://x.example' }, // icon
			{ title_en: 'X', slug: 'ok' }, // external URL missing
			{ title_en: 'X', slug: 'ok', externalUrl: 'ftp://x' } // external URL scheme
		];
		for (const fields of cases) {
			const result = await actions.create!(formEvent(fields) as never);
			expect(result, JSON.stringify(fields)).toMatchObject({ status: 400 });
		}
		expect(state.inserts).toHaveLength(0);
	});

	it('maps a duplicate slug to a 409 conflict', async () => {
		state.nextThrow = Object.assign(new Error('duplicate key'), { code: '23505' });
		const result = await actions.create!(
			formEvent({ title_en: 'X', slug: 'taken', externalUrl: 'https://x.example' }) as never
		);
		expect(result).toMatchObject({ status: 409 });
	});
});

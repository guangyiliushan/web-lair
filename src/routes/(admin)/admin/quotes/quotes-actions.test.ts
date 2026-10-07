import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin 摘录 actions (C3): the P2 contract holds -
 * requireAdminRole runs first for all three, malformed ids never reach the
 * uuid column, unknown ids answer 404 through the `returning` probe, and the
 * create payload trims + nulls empty optional fields. The db module is
 * mocked; zod-free by design (these actions validate by hand like the
 * categories precedent).
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		updatedRows: [{ id: 'row' }] as unknown[],
		deletedRows: [{ id: 'row' }] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));

import { requireAdminRole } from '$lib/server/authz';
import { actions, load } from './+page.server';

const guardMock = vi.mocked(requireAdminRole);
const ROW_ID = '11111111-1111-7111-8111-111111111111';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/quotes', { method: 'POST', body }) };
}

async function callAction(name: string, fields: Record<string, string>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = await fn(makeEvent(fields) as never);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('admin quotes actions', () => {
	beforeEach(() => {
		guardMock.mockClear();
		state.inserts = [];
		state.updates = [];
		state.deletes = [];
		state.updatedRows = [{ id: 'row' }];
		state.deletedRows = [{ id: 'row' }];

		Object.assign(dbMock, {
			insert: vi.fn((table: unknown) => ({
				values: async (values: Record<string, unknown>) => {
					state.inserts.push({ table, values });
					return [{ id: 'new-row' }];
				}
			})),
			update: vi.fn((table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => {
							state.updates.push({ table, values });
							return state.updatedRows;
						}
					})
				})
			})),
			delete: vi.fn((table: unknown) => ({
				where: () => ({
					returning: async () => {
						state.deletes.push({ table });
						return state.deletedRows;
					}
				})
			})),
			select: vi.fn(() => {
				throw new Error('db must not be reached without the guard');
			})
		});
	});

	it('runs every action behind the admin guard first', async () => {
		for (const name of ['create', 'update', 'delete']) {
			await callAction(name, {});
		}
		expect(guardMock).toHaveBeenCalledTimes(3);
	});

	it('rejects an empty content and trims optional fields into nulls', async () => {
		const empty = await callAction('create', { content: '   ' });
		expect(empty.result).toMatchObject({ status: 400, data: { error: '摘录内容不能为空' } });
		expect(state.inserts).toHaveLength(0);

		const ok = await callAction('create', {
			content: '  胆小鬼连幸福都害怕。  ',
			author: ' 太宰治 ',
			source: '  '
		});
		expect(ok.result).toMatchObject({ success: true });
		expect(state.inserts[0].values).toEqual({
			content: '胆小鬼连幸福都害怕。',
			author: '太宰治',
			source: null
		});
	});

	it('rejects malformed ids before they reach the database', async () => {
		const update = await callAction('update', { id: 'not-a-uuid', content: 'x' });
		expect(update.result).toMatchObject({ status: 400, data: { error: '缺少摘录 ID' } });
		const del = await callAction('delete', { id: 'not-a-uuid' });
		expect(del.result).toMatchObject({ status: 400, data: { error: '缺少摘录 ID' } });
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('answers 404 when the row is gone and writes on a hit', async () => {
		state.updatedRows = [];
		state.deletedRows = [];
		const miss = await callAction('update', { id: ROW_ID, content: 'x' });
		expect(miss.result).toMatchObject({ status: 404, data: { error: '摘录不存在' } });
		const missDelete = await callAction('delete', { id: ROW_ID });
		expect(missDelete.result).toMatchObject({ status: 404, data: { error: '摘录不存在' } });

		state.updatedRows = [{ id: ROW_ID }];
		state.deletedRows = [{ id: ROW_ID }];
		state.updates = [];
		state.deletes = [];
		const hit = await callAction('update', { id: ROW_ID, content: '新的摘录', author: 'A' });
		expect(hit.result).toMatchObject({ success: true });
		expect(state.updates[0].values).toEqual({ content: '新的摘录', author: 'A', source: null });
		const del = await callAction('delete', { id: ROW_ID });
		expect(del.result).toMatchObject({ success: true });
		expect(state.deletes).toHaveLength(1);
	});

	it('stops every action when the guard rejects (no db writes)', async () => {
		for (const name of ['create', 'update', 'delete'] as const) {
			guardMock.mockRejectedValueOnce(new Error('denied'));
			const { result, thrown } = await callAction(name, { content: 'x' });
			expect(result).toBeUndefined();
			expect(thrown).toBeInstanceOf(Error);
		}
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('guards the load before any db work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(load(undefined as never)).rejects.toThrow('denied');
		const selectMock = dbMock.select as ReturnType<typeof vi.fn>;
		expect(selectMock).not.toHaveBeenCalled();
	});
});

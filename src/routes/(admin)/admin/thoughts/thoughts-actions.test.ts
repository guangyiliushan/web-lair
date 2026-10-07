import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin 思考 actions (C3): guard first, uuid entry
 * guard, 404 via the `returning` probe, trimmed content. The db module is
 * mocked.
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
import { actions } from './+page.server';

const guardMock = vi.mocked(requireAdminRole);
const ROW_ID = '22222222-2222-7222-8222-222222222222';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/thoughts', { method: 'POST', body }) };
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

describe('admin thoughts actions', () => {
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
			}))
		});
	});

	it('runs every action behind the admin guard first', async () => {
		for (const name of ['create', 'update', 'delete']) {
			await callAction(name, {});
		}
		expect(guardMock).toHaveBeenCalledTimes(3);
	});

	it('rejects empty content and stores the trimmed value', async () => {
		const empty = await callAction('create', { content: '  \n ' });
		expect(empty.result).toMatchObject({ status: 400, data: { error: '思考内容不能为空' } });
		expect(state.inserts).toHaveLength(0);

		const ok = await callAction('create', { content: ' 问题的栖息地。 ' });
		expect(ok.result).toMatchObject({ success: true });
		expect(state.inserts[0].values).toEqual({ content: '问题的栖息地。' });
	});

	it('rejects malformed ids and answers 404 on missing rows', async () => {
		const malformed = await callAction('update', { id: 'nope', content: 'x' });
		expect(malformed.result).toMatchObject({ status: 400, data: { error: '缺少思考 ID' } });
		expect(state.updates).toHaveLength(0);

		const malformedDelete = await callAction('delete', { id: 'nope' });
		expect(malformedDelete.result).toMatchObject({ status: 400, data: { error: '缺少思考 ID' } });
		expect(state.deletes).toHaveLength(0);

		state.updatedRows = [];
		const miss = await callAction('update', { id: ROW_ID, content: 'x' });
		expect(miss.result).toMatchObject({ status: 404, data: { error: '思考不存在' } });
		state.updates = [];

		state.updatedRows = [{ id: ROW_ID }];
		const hit = await callAction('update', { id: ROW_ID, content: '更新后的思考' });
		expect(hit.result).toMatchObject({ success: true });
		expect(state.updates[0].values).toEqual({ content: '更新后的思考' });

		state.deletedRows = [];
		const missDelete = await callAction('delete', { id: ROW_ID });
		expect(missDelete.result).toMatchObject({ status: 404, data: { error: '思考不存在' } });
		state.deletes = [];
		state.deletedRows = [{ id: ROW_ID }];
		const del = await callAction('delete', { id: ROW_ID });
		expect(del.result).toMatchObject({ success: true });
		expect(state.deletes).toHaveLength(1);
	});

	it('stops the action when the guard rejects (no db writes)', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		const { result, thrown } = await callAction('create', { content: 'x' });
		expect(result).toBeUndefined();
		expect(thrown).toBeInstanceOf(Error);
		expect(state.inserts).toHaveLength(0);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin 微记 actions (C3): guard first, uuid entry
 * guard, kind whitelist (shared moment-meta) with the DB CHECK as backstop
 * (23514 through the production `cause` shape), 404 via `returning`. The db
 * module is mocked.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		updatedRows: [{ id: 'row' }] as unknown[],
		deletedRows: [{ id: 'row' }] as unknown[],
		updateError: null as unknown,
		insertError: null as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));

import { requireAdminRole } from '$lib/server/authz';
import { actions, load } from './+page.server';

const guardMock = vi.mocked(requireAdminRole);
const ROW_ID = '33333333-3333-7333-8333-333333333333';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/moments', { method: 'POST', body }) };
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

describe('admin moments actions', () => {
	beforeEach(() => {
		guardMock.mockClear();
		state.inserts = [];
		state.updates = [];
		state.deletes = [];
		state.updatedRows = [{ id: 'row' }];
		state.deletedRows = [{ id: 'row' }];
		state.updateError = null;
		state.insertError = null;

		Object.assign(dbMock, {
			insert: vi.fn((table: unknown) => ({
				values: async (values: Record<string, unknown>) => {
					if (state.insertError) throw state.insertError;
					state.inserts.push({ table, values });
					return [{ id: 'new-row' }];
				}
			})),
			update: vi.fn((table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => {
							if (state.updateError) throw state.updateError;
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

	it('validates content and the kind whitelist on create', async () => {
		const empty = await callAction('create', { content: ' ', type: 'life' });
		expect(empty.result).toMatchObject({ status: 400, data: { error: '微记内容不能为空' } });

		const badKind = await callAction('create', { content: '打卡', type: 'math' });
		expect(badKind.result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });
		expect(state.inserts).toHaveLength(0);

		const ok = await callAction('create', { content: '折腾了一下午的桌宠', type: 'tech' });
		expect(ok.result).toMatchObject({ success: true });
		expect(state.inserts[0].values).toEqual({ content: '折腾了一下午的桌宠', type: 'tech' });
	});

	it('maps the DB CHECK backstop (cause-shaped 23514) to a 400', async () => {
		state.updateError = Object.assign(new Error('check'), { cause: { code: '23514' } });
		const { result } = await callAction('update', {
			id: ROW_ID,
			content: 'x',
			type: 'life'
		});
		expect(result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });
	});

	it('maps the DB CHECK backstop (cause-shaped 23514) to a 400 on create too', async () => {
		state.insertError = Object.assign(new Error('check'), { cause: { code: '23514' } });
		const { result } = await callAction('create', { content: 'x', type: 'life' });
		expect(result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });
	});

	it('rejects malformed ids and answers 404 on missing rows', async () => {
		const malformed = await callAction('delete', { id: 'nope' });
		expect(malformed.result).toMatchObject({ status: 400, data: { error: '缺少微记 ID' } });
		expect(state.deletes).toHaveLength(0);

		const malformedUpdate = await callAction('update', { id: 'nope', content: 'x', type: 'life' });
		expect(malformedUpdate.result).toMatchObject({ status: 400, data: { error: '缺少微记 ID' } });
		expect(state.updates).toHaveLength(0);

		const badKindUpdate = await callAction('update', { id: ROW_ID, content: 'x', type: 'math' });
		expect(badKindUpdate.result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });
		expect(state.updates).toHaveLength(0);

		state.updatedRows = [];
		const miss = await callAction('update', { id: ROW_ID, content: 'x', type: 'life' });
		expect(miss.result).toMatchObject({ status: 404, data: { error: '微记不存在' } });
		state.updates = [];

		state.updatedRows = [{ id: ROW_ID }];
		const hit = await callAction('update', { id: ROW_ID, content: '更新', type: 'media' });
		expect(hit.result).toMatchObject({ success: true });
		expect(state.updates[0].values).toEqual({ content: '更新', type: 'media' });

		state.deletedRows = [];
		const missDelete = await callAction('delete', { id: ROW_ID });
		expect(missDelete.result).toMatchObject({ status: 404, data: { error: '微记不存在' } });
		state.deletes = [];

		state.deletedRows = [{ id: ROW_ID }];
		const del = await callAction('delete', { id: ROW_ID });
		expect(del.result).toMatchObject({ success: true });
		expect(state.deletes).toHaveLength(1);
	});

	it('stops every action when the guard rejects (no db writes)', async () => {
		for (const name of ['create', 'update', 'delete'] as const) {
			guardMock.mockRejectedValueOnce(new Error('denied'));
			const { result, thrown } = await callAction(name, { content: 'x', type: 'life' });
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

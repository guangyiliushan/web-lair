import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiAgentMemories } from '$lib/server/db/ai';

/**
 * Route-level tests for the AI console actions (AI-2): memory-card CRUD
 * (validation, the 50-card cap, 404 paths) and the archive toggle.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selects: [] as unknown[][],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		updatedRows: [{ id: 'mem-1' }] as unknown[],
		deletedRows: [{ id: 'mem-1' }] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));

import { actions } from './+page.server';

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
	return { request: new Request('http://x/admin/ai', { method: 'POST', body }) };
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

const MEM_ID = '01900000-0000-7000-8000-00000000aa01';

describe('AI console actions', () => {
	beforeEach(() => {
		state.selects = [];
		state.inserts = [];
		state.updates = [];
		state.deletes = [];
		state.updatedRows = [{ id: 'mem-1' }];
		state.deletedRows = [{ id: 'mem-1' }];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selects.shift() ?? [])),
			insert: vi.fn((table: unknown) => ({
				values: async (values: Record<string, unknown>) => {
					state.inserts.push({ table, values });
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

	it('rejects empty and oversized memory content', async () => {
		expect((await callAction('saveMemory', { content: '   ' })).result).toMatchObject({
			status: 400
		});
		const long = await callAction('saveMemory', { content: 'x'.repeat(2001) });
		expect(long.result).toMatchObject({ status: 400 });
		expect(state.inserts).toHaveLength(0);
	});

	it('creates a memory card under the cap', async () => {
		state.selects = [[{ n: 3 }]];
		const { result } = await callAction('saveMemory', { content: ' remembers dry tone ' });
		expect(result).toMatchObject({ message: '记忆卡已创建' });
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(aiAgentMemories);
		expect(state.inserts[0].values).toEqual({ content: 'remembers dry tone' });
	});

	it('enforces the 50-card cap', async () => {
		state.selects = [[{ n: 50 }]];
		const { result } = await callAction('saveMemory', { content: 'one more' });
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data?: { message?: string } }).data?.message).toContain('50');
		expect(state.inserts).toHaveLength(0);
	});

	it('updates by id and rejects malformed ids', async () => {
		const bad = await callAction('saveMemory', { id: 'not-a-uuid', content: 'x' });
		expect(bad.result).toMatchObject({ status: 400, data: { message: '标识无效' } });

		const { result } = await callAction('saveMemory', { id: MEM_ID, content: 'updated' });
		expect(result).toMatchObject({ message: '记忆卡已更新' });
		expect(state.updates[0].values).toEqual({ content: 'updated' });

		state.updatedRows = [];
		const missing = await callAction('saveMemory', { id: MEM_ID, content: 'x' });
		expect(missing.result).toMatchObject({ status: 404 });
	});

	it('deletes a memory card and reports missing rows', async () => {
		const { result } = await callAction('deleteMemory', { id: MEM_ID });
		expect(result).toMatchObject({ message: '记忆卡已删除' });
		expect(state.deletes[0].table).toBe(aiAgentMemories);

		state.deletedRows = [];
		const missing = await callAction('deleteMemory', { id: MEM_ID });
		expect(missing.result).toMatchObject({ status: 404 });
	});

	it('toggles the archive flag with a validated id', async () => {
		const archived = await callAction('archiveConversation', { id: MEM_ID, archive: 'true' });
		expect(archived.result).toMatchObject({ message: '会话已归档' });
		expect(state.updates[0].values.archivedAt).toBeInstanceOf(Date);

		const restored = await callAction('archiveConversation', { id: MEM_ID, archive: 'false' });
		expect(restored.result).toMatchObject({ message: '已取消归档' });
		expect(state.updates[1].values.archivedAt).toBeNull();

		const bad = await callAction('archiveConversation', { id: 'nope', archive: 'true' });
		expect(bad.result).toMatchObject({ status: 400 });
	});
});

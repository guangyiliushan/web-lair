import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the moments editor (B2a UI P0, P7).
 *
 * The write surface moved off the list dialog: `load` reads `?id=` (malformed
 * and missing ids are both 404, guard first), and one `save` action branches
 * on the optional id (insert / update, 404 via `returning`) before redirecting
 * back to the list with the one-shot `?saved=1` flash. The db module is
 * mocked; the update path reuses the production 23514 `cause` shape.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectRows: [] as unknown[],
		limitArgs: [] as unknown[],
		inserts: [] as { values: Record<string, unknown> }[],
		updates: [] as { values: Record<string, unknown> }[],
		updatedRows: [{ id: 'row' }] as unknown[],
		updateError: null as unknown,
		insertError: null as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));

import { requireAdminRole } from '$lib/server/authz';
import { actions, load } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

const guardMock = vi.mocked(requireAdminRole);
const ROW_ID = '77777777-7777-7777-8777-777777777777';

function loadEvent(query: string) {
	return { url: new URL(`http://x/admin/moments/edit${query}`) } as never;
}

function saveEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/moments/edit?/save', { method: 'POST', body }) };
}

async function callSave(fields: Record<string, string>) {
	try {
		const result = await actions.save(saveEvent(fields) as never);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('admin moments editor route', () => {
	beforeEach(() => {
		guardMock.mockClear();
		state.selectRows = [];
		state.limitArgs = [];
		state.inserts = [];
		state.updates = [];
		state.updatedRows = [{ id: 'row' }];
		state.updateError = null;
		state.insertError = null;

		Object.assign(dbMock, {
			select: vi.fn(() => ({
				from: () => ({
					where: () => ({
						limit: async (count: unknown) => {
							state.limitArgs.push(count);
							return state.selectRows;
						}
					})
				})
			})),
			insert: vi.fn(() => ({
				values: async (values: Record<string, unknown>) => {
					if (state.insertError) throw state.insertError;
					state.inserts.push({ values });
					return [{ id: 'new-row' }];
				}
			})),
			update: vi.fn(() => ({
				set: (values: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => {
							if (state.updateError) throw state.updateError;
							state.updates.push({ values });
							return state.updatedRows;
						}
					})
				})
			}))
		});
	});

	it('guards the load before any db work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(load(loadEvent(''))).rejects.toThrow('denied');
		expect(dbMock.select as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it('returns an empty editor for a new moment', async () => {
		const data = (await load(loadEvent(''))) as unknown as {
			moment: unknown;
			kinds: readonly string[];
			headerTitle: string;
			headerActions: { href?: string }[];
		};
		expect(data.moment).toBeNull();
		expect([...data.kinds]).toEqual(['life', 'tech', 'media', 'other']);
		expect(data.headerTitle).toBe('写一条微记');
		expect(data.headerActions[0]?.href).toBe('/admin/moments');
	});

	it('answers 404 for malformed ids without querying', async () => {
		const selectMock = dbMock.select as ReturnType<typeof vi.fn>;
		await expect(load(loadEvent('?id=nope'))).rejects.toMatchObject({ status: 404 });
		expect(selectMock).not.toHaveBeenCalled();
	});

	it('answers 404 when the row is missing', async () => {
		state.selectRows = [];
		await expect(load(loadEvent(`?id=${ROW_ID}`))).rejects.toMatchObject({ status: 404 });
		expect(state.limitArgs).toContain(1);
	});

	it('hydrates the editor from the row', async () => {
		state.selectRows = [
			{
				id: ROW_ID,
				content: '## 今天\n\n- 一条',
				type: 'tech',
				up: 1,
				down: 0,
				createdAt: new Date('2026-10-21T00:00:00Z')
			}
		];
		const data = (await load(loadEvent(`?id=${ROW_ID}`))) as unknown as {
			moment: { content: string; type: string } | null;
			headerTitle: string;
		};
		expect(data.moment).toMatchObject({ content: '## 今天\n\n- 一条', type: 'tech' });
		expect(data.headerTitle).toBe('编辑微记');
	});

	it('validates content, kind and the id shape', async () => {
		const empty = await callSave({ content: ' ', type: 'life' });
		expect(empty.result).toMatchObject({ status: 400, data: { error: '微记内容不能为空' } });

		const badKind = await callSave({ content: '打卡', type: 'math' });
		expect(badKind.result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });

		const badId = await callSave({ id: 'nope', content: '打卡', type: 'life' });
		expect(badId.result).toMatchObject({ status: 400, data: { error: '缺少微记 ID' } });

		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
	});

	it('creates a moment and redirects to the list flash', async () => {
		const { thrown } = await callSave({ content: '## 一段\n\n正文', type: 'tech' });
		expect(thrown).toMatchObject({ status: 303, location: '/admin/moments?saved=1' });
		expect(state.inserts[0]?.values).toEqual({ content: '## 一段\n\n正文', type: 'tech' });
	});

	it('stores LF-only bodies even when the form arrives with CRLF', async () => {
		await callSave({ content: '## 一段\r\n\r\n正文\r\n', type: 'tech' });
		expect(state.inserts[0]?.values).toEqual({ content: '## 一段\n\n正文', type: 'tech' });
	});

	it('updates an existing moment and redirects', async () => {
		const { thrown } = await callSave({ id: ROW_ID, content: '更新', type: 'media' });
		expect(thrown).toMatchObject({ status: 303, location: '/admin/moments?saved=1' });
		expect(state.updates[0]?.values).toEqual({ content: '更新', type: 'media' });
	});

	it('answers 404 when updating a row that no longer exists', async () => {
		state.updatedRows = [];
		const { result } = await callSave({ id: ROW_ID, content: 'x', type: 'life' });
		expect(result).toMatchObject({ status: 404, data: { error: '微记不存在' } });
	});

	it('maps the DB CHECK backstop (cause-shaped 23514) to a 400', async () => {
		state.insertError = Object.assign(new Error('check'), { cause: { code: '23514' } });
		const { result } = await callSave({ content: 'x', type: 'life' });
		expect(result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });

		state.insertError = null;
		state.updateError = Object.assign(new Error('check'), { cause: { code: '23514' } });
		const updated = await callSave({ id: ROW_ID, content: 'x', type: 'life' });
		expect(updated.result).toMatchObject({ status: 400, data: { error: '微记类型无效' } });
	});

	it('stops before any write when the guard rejects', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		const { result, thrown } = await callSave({ content: 'x', type: 'life' });
		expect(result).toBeUndefined();
		expect(thrown).toBeInstanceOf(Error);
		expect(state.inserts).toHaveLength(0);
	});
});

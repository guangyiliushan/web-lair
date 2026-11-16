import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin moments *delete* action.
 *
 * Create/update moved to `/admin/moments/edit` together with the Markdown
 * editor - their coverage lives in `edit/moments-edit-route.test.ts`. This file
 * pins the list-side surface: guard first, uuid entry guard, 404 via `returning`.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		deletes: [] as { table: unknown }[],
		deletedRows: [{ id: 'row' }] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));

import { requireAdminRole } from '$lib/server/authz';
import { actions } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions
// stay in sync with the zh-cn catalog (same convention as the e2e fixtures
// that assert Chinese copy).
overwriteGetLocale(() => 'zh-cn');

const guardMock = vi.mocked(requireAdminRole);
const ROW_ID = '33333333-3333-7333-8333-333333333333';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/moments', { method: 'POST', body }) };
}

async function callDelete(fields: Record<string, string>) {
	try {
		const result = await actions.delete(makeEvent(fields) as never);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('admin moments delete action', () => {
	beforeEach(() => {
		guardMock.mockClear();
		state.deletes = [];
		state.deletedRows = [{ id: 'row' }];

		Object.assign(dbMock, {
			delete: vi.fn((table: unknown) => ({
				where: () => ({
					returning: async () => {
						state.deletes.push({ table });
						return state.deletedRows;
					}
				})
			})),
			insert: vi.fn(() => {
				throw new Error('insert is not part of the list route');
			}),
			update: vi.fn(() => {
				throw new Error('update is not part of the list route');
			}),
			select: vi.fn(() => {
				throw new Error('db must not be reached without the guard');
			})
		});
	});

	it('runs behind the admin guard first', async () => {
		await callDelete({ id: ROW_ID });
		expect(guardMock).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed ids before touching the db', async () => {
		const malformed = await callDelete({ id: 'nope' });
		expect(malformed.result).toMatchObject({ status: 400, data: { error: '缺少微记 ID' } });
		expect(state.deletes).toHaveLength(0);
	});

	it('answers 404 when the row is already gone', async () => {
		state.deletedRows = [];
		const miss = await callDelete({ id: ROW_ID });
		expect(miss.result).toMatchObject({ status: 404, data: { error: '微记不存在' } });
	});

	it('deletes an existing row', async () => {
		const del = await callDelete({ id: ROW_ID });
		expect(del.result).toMatchObject({ success: true });
		expect(state.deletes).toHaveLength(1);
	});

	it('stops before any db work when the guard rejects', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		const { result, thrown } = await callDelete({ id: ROW_ID });
		expect(result).toBeUndefined();
		expect(thrown).toBeInstanceOf(Error);
		expect(state.deletes).toHaveLength(0);
	});
});

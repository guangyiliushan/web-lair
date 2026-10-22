import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin posts list row actions (`?/status` and
 * `?/purge`).
 *
 * `?/status` is the trash / restore pair the row buttons submit: restoring
 * follows the same target rule as `setNoteStatus` (published when it had been
 * public, draft otherwise) and the write is CAS'd on the status we read.
 *
 * `?/purge` is the permanent delete that only appears in the overflow menu of
 * an already-trashed row. It mirrors the pages hard-delete (M1 / R2-3): drafts
 * first because `drafts.ref_id` is polymorphic, then the row, then the
 * file-reference cleanup.
 */
const { dbMock, state, guardMock, syncCheck } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		current: [] as Record<string, unknown>[],
		updatedRows: [{ id: 'row' }] as unknown[],
		selectWhere: [] as unknown[],
		updateWhere: [] as unknown[],
		updates: [] as Record<string, unknown>[],
		deletes: [] as { cond: unknown }[],
		deleteResults: [] as unknown[][],
		syncCalls: [] as { type: string; id: string }[]
	},
	guardMock: vi.fn(async () => {}),
	// Records the ref batches a purge clears, in call order.
	syncCheck: vi.fn(async (...args: unknown[]): Promise<void> => {
		state.syncCalls.push(args[1] as { type: string; id: string });
	})
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/services/post-drafts', () => ({
	draftsForPosts: vi.fn(async () => new Set())
}));
// Its own teeth live in file-references.test.ts; here we pin that a hard
// delete clears the references and in which order.
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: syncCheck }));

import { actions } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

const POST_ID = '11111111-1111-1111-1111-111111111111';
const PUBLISHED_AT = new Date('2026-01-01T00:00:00Z');

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/posts', { method: 'POST', body }) };
}

function run(
	name: 'status' | 'purge',
	fields: Record<string, string>
): Promise<Record<string, unknown>> {
	return (actions as unknown as Record<string, (e: never) => Promise<unknown>>)[name](
		makeEvent(fields) as never
	) as Promise<Record<string, unknown>>;
}

/** Chain shared by the outer handle and the transaction handle. */
function chain(selectResult: unknown[]): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: (...args: unknown[]) => {
			state.selectWhere.push(args[0]);
			return c;
		},
		limit: ret,
		for: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(selectResult).then(res, rej)
	});
	return c;
}

function makeTx(selectResult: unknown[]): Record<string, unknown> {
	const c = chain(selectResult);
	Object.assign(c, {
		select: () => c,
		delete: (table: unknown) => ({
			where: (cond: unknown) => {
				state.deletes.push({ cond, ...{ table } });
				const rows = state.deleteResults.shift() ?? [];
				return Object.assign(Promise.resolve(rows), { returning: async () => rows });
			}
		})
	});
	return c;
}

function resetState() {
	state.current = [{ id: POST_ID, status: 'published', publishedAt: PUBLISHED_AT }];
	state.updatedRows = [{ id: POST_ID }];
	state.selectWhere = [];
	state.updateWhere = [];
	state.updates = [];
	state.deletes = [];
	state.deleteResults = [];
	state.syncCalls = [];
	syncCheck.mockClear();
}

describe('admin posts list status action', () => {
	beforeEach(() => {
		guardMock.mockClear();
		resetState();

		Object.assign(dbMock, {
			select: vi.fn(() => chain(state.current)),
			update: vi.fn(() => ({
				set: (values: Record<string, unknown>) => ({
					where: (...args: unknown[]) => {
						state.updateWhere.push(args[0]);
						return {
							returning: async () => {
								state.updates.push(values);
								return state.updatedRows;
							}
						};
					}
				})
			})),
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx([])))
		});
	});

	it('guards before any db work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(run('status', { id: POST_ID, action: 'trash' })).rejects.toThrow('denied');
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('rejects a malformed id or an unknown verb', async () => {
		expect((await run('status', { id: 'nope', action: 'trash' })).status).toBe(400);
		expect((await run('status', { id: POST_ID, action: 'purge' })).status).toBe(400);
		expect(state.updates).toHaveLength(0);
	});

	it('404s on a missing row', async () => {
		state.current = [];
		expect((await run('status', { id: POST_ID, action: 'trash' })).status).toBe(404);
		expect(state.updates).toHaveLength(0);
	});

	it('moves a post to trash', async () => {
		expect((await run('status', { id: POST_ID, action: 'trash' })).status).toBeUndefined();
		expect(state.updates[0].status).toBe('trash');
	});

	it('restores to published when the post had been public', async () => {
		state.current = [{ id: POST_ID, status: 'trash', publishedAt: PUBLISHED_AT }];
		expect((await run('status', { id: POST_ID, action: 'restore' })).status).toBeUndefined();
		expect(state.updates[0].status).toBe('published');
	});

	it('restores to draft when the post was never published', async () => {
		state.current = [{ id: POST_ID, status: 'trash', publishedAt: null }];
		expect((await run('status', { id: POST_ID, action: 'restore' })).status).toBeUndefined();
		expect(state.updates[0].status).toBe('draft');
	});

	it('short-circuits when the row is already at the target status', async () => {
		state.current = [{ id: POST_ID, status: 'trash', publishedAt: PUBLISHED_AT }];
		expect((await run('status', { id: POST_ID, action: 'trash' })).status).toBeUndefined();
		expect(state.updates).toHaveLength(0);
	});

	it('CASes on the status it read and answers 409 when it loses', async () => {
		state.updatedRows = [];
		expect((await run('status', { id: POST_ID, action: 'trash' })).status).toBe(409);
		expect(state.updateWhere).toHaveLength(1);
	});
});

describe('admin posts list purge action', () => {
	beforeEach(() => {
		guardMock.mockClear();
		resetState();

		Object.assign(dbMock, {
			select: vi.fn(() => chain(state.current)),
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
				cb(makeTx(state.current.length ? [{ id: POST_ID }] : []))
			)
		});
	});

	it('guards before any db work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(run('purge', { id: POST_ID })).rejects.toThrow('denied');
		expect(dbMock.transaction).not.toHaveBeenCalled();
	});

	it('rejects a malformed id and 404s on a missing row', async () => {
		expect((await run('purge', { id: 'nope' })).status).toBe(400);
		state.current = [];
		expect((await run('purge', { id: POST_ID })).status).toBe(404);
		expect(state.deletes).toHaveLength(0);
	});

	it('deletes drafts before the row and then clears every file reference', async () => {
		state.deleteResults = [[{ id: 'draft-1' }, { id: 'draft-2' }], []];
		expect((await run('purge', { id: POST_ID })).status).toBeUndefined();

		// Two deletes: the drafts batch, then the post row itself.
		expect(state.deletes).toHaveLength(2);
		// Both file-reference batches are cleared, and the row's own reference
		// is cleared last (drafts first keeps the drafts → files lock order).
		expect(state.syncCalls).toEqual([
			{ type: 'draft', id: 'draft-1' },
			{ type: 'draft', id: 'draft-2' },
			{ type: 'post', id: POST_ID }
		]);
	});

	it('still purges a post that never had a draft', async () => {
		state.deleteResults = [[], []];
		expect((await run('purge', { id: POST_ID })).status).toBeUndefined();
		expect(state.deletes).toHaveLength(2);
		expect(state.syncCalls).toEqual([{ type: 'post', id: POST_ID }]);
	});
});

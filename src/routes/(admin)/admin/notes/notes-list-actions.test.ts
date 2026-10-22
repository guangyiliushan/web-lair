import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin notes list row actions (`?/status` and
 * `?/purge`).
 *
 * `?/status` is the trash / restore pair the row buttons submit. It reuses the
 * edit route's `setNoteStatus`, so the restore-target rules cannot drift
 * between the two surfaces - this spec pins that the list calls it and maps
 * its result kinds onto HTTP answers.
 *
 * `?/purge` is the permanent delete that only appears in the overflow menu of
 * an already-trashed row. It mirrors the pages hard-delete (M1 / R2-3): drafts
 * first because `drafts.ref_id` is polymorphic, then the row, then the
 * file-reference cleanup.
 */
const { dbMock, state, service, guardMock, syncCheck } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		deletes: [] as unknown[],
		deleteResults: [] as unknown[][],
		syncCalls: [] as { type: string; id: string }[],
		rowExists: true
	},
	service: {
		setNoteStatus: vi.fn(async (): Promise<{ kind: string; message?: string }> => ({ kind: 'ok' }))
	},
	guardMock: vi.fn(async () => {}),
	// Records the ref batches a purge clears, in call order.
	syncCheck: vi.fn(async (...args: unknown[]): Promise<void> => {
		state.syncCalls.push(args[1] as { type: string; id: string });
	})
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/services/note-drafts', () => ({
	draftsForNotes: vi.fn(async () => new Set<string>()),
	setNoteStatus: service.setNoteStatus
}));
// Its own teeth live in file-references.test.ts; here we pin that a hard
// delete clears the references and in which order.
vi.mock('$lib/server/services/file-references', () => ({ syncFileReferences: syncCheck }));

import { actions } from './+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

const NOTE_ID = '11111111-1111-1111-1111-111111111111';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/notes', { method: 'POST', body }) };
}

function run(
	name: 'status' | 'purge',
	fields: Record<string, string>
): Promise<Record<string, unknown>> {
	return (actions as unknown as Record<string, (e: never) => Promise<unknown>>)[name](
		makeEvent(fields) as never
	) as Promise<Record<string, unknown>>;
}

function makeTx(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		select: () => c,
		from: ret,
		where: ret,
		limit: ret,
		for: ret,
		then: (res: (v: unknown) => unknown) =>
			Promise.resolve(state.rowExists ? [{ id: NOTE_ID }] : []).then(res),
		delete: () => ({
			where: () => {
				const rows = state.deleteResults.shift() ?? [];
				state.deletes.push(rows);
				return Object.assign(Promise.resolve(rows), { returning: async () => rows });
			}
		})
	});
	return c;
}

describe('admin notes list status action', () => {
	beforeEach(() => {
		guardMock.mockClear();
		service.setNoteStatus.mockReset();
		service.setNoteStatus.mockResolvedValue({ kind: 'ok' });
	});

	it('guards before any service work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(run('status', { id: NOTE_ID, action: 'trash' })).rejects.toThrow('denied');
		expect(service.setNoteStatus).not.toHaveBeenCalled();
	});

	it('rejects a malformed id or an unknown verb', async () => {
		expect((await run('status', { id: 'nope', action: 'trash' })).status).toBe(400);
		expect((await run('status', { id: NOTE_ID, action: 'purge' })).status).toBe(400);
		expect(service.setNoteStatus).not.toHaveBeenCalled();
	});

	it('forwards both verbs to the shared status service', async () => {
		await run('status', { id: NOTE_ID, action: 'trash' });
		await run('status', { id: NOTE_ID, action: 'restore' });
		expect(service.setNoteStatus).toHaveBeenNthCalledWith(1, NOTE_ID, 'trash');
		expect(service.setNoteStatus).toHaveBeenNthCalledWith(2, NOTE_ID, 'restore');
	});

	it('maps the service result kinds onto HTTP answers', async () => {
		service.setNoteStatus.mockResolvedValueOnce({ kind: 'not-found' });
		expect((await run('status', { id: NOTE_ID, action: 'trash' })).status).toBe(404);

		service.setNoteStatus.mockResolvedValueOnce({ kind: 'invalid', message: 'bad' });
		const invalid = await run('status', { id: NOTE_ID, action: 'trash' });
		expect(invalid.status).toBe(400);
		expect(invalid.data).toMatchObject({ error: 'bad' });

		expect((await run('status', { id: NOTE_ID, action: 'trash' })).status).toBeUndefined();
	});
});

describe('admin notes list purge action', () => {
	beforeEach(() => {
		guardMock.mockClear();
		state.deletes = [];
		state.deleteResults = [];
		state.syncCalls = [];
		state.rowExists = true;
		syncCheck.mockClear();

		Object.assign(dbMock, {
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()))
		});
	});

	it('guards before any db work', async () => {
		guardMock.mockRejectedValueOnce(new Error('denied'));
		await expect(run('purge', { id: NOTE_ID })).rejects.toThrow('denied');
		expect(dbMock.transaction).not.toHaveBeenCalled();
	});

	it('rejects a malformed id and 404s on a missing row', async () => {
		expect((await run('purge', { id: 'nope' })).status).toBe(400);
		state.rowExists = false;
		expect((await run('purge', { id: NOTE_ID })).status).toBe(404);
		expect(state.deletes).toHaveLength(0);
		expect(state.syncCalls).toHaveLength(0);
	});

	it('deletes drafts before the row and then clears every file reference', async () => {
		state.deleteResults = [[{ id: 'draft-1' }], []];
		expect((await run('purge', { id: NOTE_ID })).status).toBeUndefined();

		// Two deletes: the drafts batch, then the note row itself.
		expect(state.deletes).toHaveLength(2);
		expect(state.syncCalls).toEqual([
			{ type: 'draft', id: 'draft-1' },
			{ type: 'note', id: NOTE_ID }
		]);
	});

	it('still purges a note that never had a draft', async () => {
		state.deleteResults = [[], []];
		expect((await run('purge', { id: NOTE_ID })).status).toBeUndefined();
		expect(state.deletes).toHaveLength(2);
		expect(state.syncCalls).toEqual([{ type: 'note', id: NOTE_ID }]);
	});
});

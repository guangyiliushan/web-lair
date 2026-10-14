import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Reference maintenance unit teeth (ST-3 3b1; Q6 flip matrix + Q15 diff):
 * add -> attached (unconditional, lock-taking update), LAST-ref removal ->
 * detached with a `now()` anchor, a file still referenced by ANOTHER target
 * stays attached, pending rows are never dragged into detached, unknown keys
 * are skipped with a warning, and both concurrency guards hold - the resolve
 * takes FOR KEY SHARE (no in-transaction 23503: postgres.js aborts the whole
 * transaction on any statement error, so a catch would be a lie) and the
 * remove branch locks its candidates FOR NO KEY UPDATE before deciding.
 * WHERE clauses are pinned as full dialect snapshots, not fragments.
 */
const { executor, state } = vi.hoisted(() => {
	type Row = Record<string, unknown>;
	const state = {
		selectQueue: [] as Row[][],
		inserts: [] as { values: Record<string, unknown> }[],
		updates: [] as { values: Record<string, unknown>; where?: unknown }[],
		deletes: [] as { where?: unknown }[],
		locks: [] as string[],
		lockTables: [] as unknown[],
		selectWheres: [] as unknown[],
		orderBys: [] as unknown[][]
	};
	const chain = () => {
		const c: Record<string, unknown> = {};
		let fromTable: unknown;
		const ret = () => c;
		Object.assign(c, {
			from: (table: unknown) => {
				fromTable = table;
				return c;
			},
			where: (cond?: unknown) => {
				state.selectWheres.push(cond);
				return c;
			},
			innerJoin: ret,
			limit: ret,
			orderBy: (...args: unknown[]) => {
				state.orderBys.push(args);
				return c;
			},
			for: (mode: string) => {
				state.locks.push(mode);
				state.lockTables.push(fromTable);
				return c;
			},
			then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
				Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
		});
		return c;
	};
	const executor = {
		select: vi.fn(() => chain()),
		insert: vi.fn(() => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoNothing: async () => {
					state.inserts.push({ values });
				}
			})
		})),
		update: vi.fn(() => ({
			set: (values: Record<string, unknown>) => ({
				where: async (where: unknown) => {
					state.updates.push({ values, where });
				}
			})
		})),
		delete: vi.fn(() => ({
			where: async (where: unknown) => {
				state.deletes.push({ where });
			}
		}))
	} as unknown as RefsExecutor;
	return { executor, state };
});

// The executor is cast to the production type for call sites; keep typed
// mock handles for history/ordering assertions.
const selectMock = executor.select as unknown as Mock;
const insertMock = executor.insert as unknown as Mock;
const updateMock = executor.update as unknown as Mock;
const deleteMock = executor.delete as unknown as Mock;

vi.mock('$lib/server/db', () => ({ db: executor }));

import { files as filesTable } from '$lib/server/db/content';
import { keysFromContent, syncFileReferences, type RefsExecutor } from './file-references';

const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);
const KEY = `ab/${'a'.repeat(64)}.png`;
const OTHER_KEY = `cd/${'b'.repeat(64)}.jpg`;

beforeEach(() => {
	state.selectQueue = [];
	state.inserts = [];
	state.updates = [];
	state.deletes = [];
	state.locks = [];
	state.lockTables = [];
	state.selectWheres = [];
	state.orderBys = [];
	vi.restoreAllMocks();
	// invocationCallOrder accumulates across tests for plain vi.fn mocks
	// (restoreAllMocks only touches spies) - clear histories explicitly so
	// the ordering teeth below read THIS test's call sequence.
	selectMock.mockClear();
	insertMock.mockClear();
	updateMock.mockClear();
	deleteMock.mockClear();
});

describe('keysFromContent', () => {
	it('extracts unique bare keys and strips variant suffixes', () => {
		const content = [
			`text /i/${KEY}@full more`,
			`again /i/${KEY}@thumb and /i/${OTHER_KEY}`,
			'ignore /i/not-a-key and /static/x.png'
		].join('\n');
		expect(keysFromContent(content)).toEqual([KEY, OTHER_KEY]);
	});

	it('handles empty/null content', () => {
		expect(keysFromContent(null)).toEqual([]);
		expect(keysFromContent(undefined)).toEqual([]);
		expect(keysFromContent('')).toEqual([]);
	});
});

describe('syncFileReferences', () => {
	it('adds a reference: KEY SHARE resolve + unconditional attach update', async () => {
		state.selectQueue = [[], [{ id: 'file-1', objectKey: KEY }]];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(state.locks).toEqual(['key share']);
		expect(state.inserts).toEqual([
			{ values: { fileId: 'file-1', refType: 'post', refId: 'post-1' } }
		]);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].values).toEqual({ status: 'attached', detachedAt: null });
		const rendered = render(state.updates[0].where);
		expect(rendered.sql).toBe('"files"."id" in ($1)');
		expect(rendered.params).toEqual(['file-1']);
		// Scope snapshots for the two SELECTs the mutation matrix used to
		// walk through (review round 2): existing refs are read for THIS
		// target only, and the resolve is by object_key.
		const existingWhere = render(state.selectWheres[0]);
		expect(existingWhere.sql).toBe(
			'("file_references"."ref_type" = $1 and "file_references"."ref_id" = $2)'
		);
		expect(existingWhere.params).toEqual(['post', 'post-1']);
		const resolveWhere = render(state.selectWheres[1]);
		expect(resolveWhere.sql).toBe('"files"."object_key" in ($1)');
		expect(resolveWhere.params).toEqual([KEY]);
		// The KEY SHARE lock belongs to the resolve SELECT (which reads files).
		expect(state.lockTables[0]).toBe(filesTable);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('detaches with a now() anchor when the LAST reference disappears', async () => {
		state.selectQueue = [
			[{ fileId: 'file-1', objectKey: KEY }],
			[], // candidate row lock (result unused)
			[] // remaining references: none
		];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, []);
		expect(state.locks).toEqual(['no key update']);
		expect(state.deletes).toHaveLength(1);
		const del = render(state.deletes[0].where);
		expect(del.sql).toBe(
			'("file_references"."ref_type" = $1 and "file_references"."ref_id" = $2 and "file_references"."file_id" in ($3))'
		);
		expect(del.params).toEqual(['post', 'post-1', 'file-1']);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].values.status).toBe('detached');
		const anchor = render(state.updates[0].values.detachedAt as unknown as SQL);
		expect(anchor.sql).toBe('now()');
		const upd = render(state.updates[0].where);
		expect(upd.sql).toBe('("files"."id" in ($1) and "files"."status" = $2)');
		expect(upd.params).toEqual(['file-1', 'attached']);
		// Query scopes (review round 2): both the candidate lock and the
		// remaining-refs snapshot target the removed ids on the right tables.
		expect(state.lockTables[0]).toBe(filesTable);
		expect(state.orderBys).toContainEqual([filesTable.id]);
		const existingWhere = render(state.selectWheres[0]);
		expect(existingWhere.params).toEqual(['post', 'post-1']);
		const lockWhere = render(state.selectWheres[1]);
		expect(lockWhere.sql).toBe('"files"."id" in ($1)');
		expect(lockWhere.params).toEqual(['file-1']);
		const remainingWhere = render(state.selectWheres[2]);
		expect(remainingWhere.sql).toBe('"file_references"."file_id" in ($1)');
		expect(remainingWhere.params).toEqual(['file-1']);
		// Ordering teeth (review round 2): the candidate lock runs BEFORE the
		// DELETE and the remaining snapshot runs AFTER it. Moving the pre-lock
		// used to keep the whole suite green.
		expect(selectMock.mock.invocationCallOrder[1]).toBeLessThan(
			deleteMock.mock.invocationCallOrder[0]
		);
		expect(selectMock.mock.invocationCallOrder[2]).toBeGreaterThan(
			deleteMock.mock.invocationCallOrder[0]
		);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('keeps the file attached while another target still references it', async () => {
		state.selectQueue = [
			[{ fileId: 'file-1', objectKey: KEY }],
			[], // candidate row lock
			[{ fileId: 'file-1' }] // another target's reference survives
		];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, []);
		expect(state.locks).toEqual(['no key update']);
		expect(state.deletes).toHaveLength(1);
		expect(state.updates).toHaveLength(0);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('is a no-op when the desired set already matches (ordered drain)', async () => {
		state.selectQueue = [[{ fileId: 'file-1', objectKey: KEY }]];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
		expect(state.locks).toEqual([]);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('handles a mixed diff: attaches the new key and detaches the old one in order', async () => {
		const OLD_KEY = `12/${'c'.repeat(64)}.png`;
		state.selectQueue = [
			[{ fileId: 'file-old', objectKey: OLD_KEY }],
			[{ id: 'file-new', objectKey: KEY }],
			[], // candidate row lock for the removed old file
			[] // remaining references: none
		];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(state.locks).toEqual(['key share', 'no key update']);
		expect(state.inserts).toHaveLength(1);
		expect(state.deletes).toHaveLength(1);
		expect(state.updates.map((row) => row.values.status)).toEqual(['attached', 'detached']);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('skips desired keys with no registry row and warns (dangling image)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.selectQueue = [[], []];
		await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toBe('[refs] skipped missing keys');
		expect(warn.mock.calls[0][1]).toEqual({ refType: 'post', refId: 'post-1', missing: 1 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
		expect(state.selectQueue).toHaveLength(0);
	});
});

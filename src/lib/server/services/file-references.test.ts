import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Reference maintenance unit teeth (ST-3 3b1; Q6 flip matrix + Q15 diff):
 * add -> attached, last-ref removal -> detached with anchor, an image still
 * referenced by ANOTHER target stays attached, pending rows are never
 * dragged into detached, unknown keys are skipped (registry row gone) and a
 * 23503 race between resolve and insert degrades to a skip.
 */
const { executor, state } = vi.hoisted(() => {
	type Row = Record<string, unknown>;
	const state = {
		selectQueue: [] as Row[][],
		inserts: [] as { values: Record<string, unknown> }[],
		updates: [] as { values: Record<string, unknown>; where?: unknown }[],
		deletes: [] as { where?: unknown }[],
		failNextInsert: null as unknown as Error | null
	};
	const chain = () => {
		const c: Record<string, unknown> = {};
		const ret = () => c;
		Object.assign(c, {
			from: ret,
			where: ret,
			innerJoin: ret,
			limit: ret,
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
					if (state.failNextInsert) {
						const error = state.failNextInsert;
						state.failNextInsert = null;
						throw error;
					}
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

vi.mock('$lib/server/db', () => ({ db: executor }));

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
	state.failNextInsert = null;
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
	it('adds a new reference and flips the file to attached', async () => {
		state.selectQueue = [
			[], // existing refs for the target
			[{ id: 'file-1', objectKey: KEY }] // resolve
		];
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(summary).toMatchObject({ added: 1, attached: 1, removed: 0, detached: 0, missing: 0 });
		expect(state.inserts).toEqual([
			{ values: { fileId: 'file-1', refType: 'post', refId: 'post-1' } }
		]);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].values).toEqual({ status: 'attached', detachedAt: null });
		// Only rows that are not already attached are touched.
		const rendered = render(state.updates[0].where);
		expect(rendered.sql).toContain('"files"."status" <>');
	});

	it('detaches with the clock anchor when the LAST reference disappears', async () => {
		state.selectQueue = [
			[{ fileId: 'file-1', objectKey: KEY }], // existing refs
			[] // remaining references after the delete: none
		];
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, []);
		expect(summary).toMatchObject({ removed: 1, detached: 1, added: 0 });
		expect(state.deletes).toHaveLength(1);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].values.status).toBe('detached');
		expect(state.updates[0].values.detachedAt).toBeInstanceOf(Date);
		// pending must STAY pending: the detach update is pinned to attached.
		const rendered = render(state.updates[0].where);
		expect(rendered.sql).toContain('"files"."status" =');
		expect(rendered.params).toContain('attached');
	});

	it('keeps the file attached while another target still references it', async () => {
		state.selectQueue = [
			[{ fileId: 'file-1', objectKey: KEY }],
			[{ fileId: 'file-1' }] // another post's ref survives
		];
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, []);
		expect(summary).toMatchObject({ removed: 1, detached: 0 });
		expect(state.deletes).toHaveLength(1);
		expect(state.updates).toHaveLength(0);
	});

	it('is a no-op when the desired set already matches (idempotent re-sync)', async () => {
		state.selectQueue = [[{ fileId: 'file-1', objectKey: KEY }]];
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(summary).toEqual({ added: 0, removed: 0, missing: 0, attached: 0, detached: 0 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('skips desired keys with no registry row', async () => {
		state.selectQueue = [[], []]; // no existing refs, nothing resolves
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(summary).toMatchObject({ added: 0, missing: 1 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
	});

	it('degrades a 23503 race (file removed between resolve and insert) to a skip', async () => {
		state.selectQueue = [[], [{ id: 'file-1', objectKey: KEY }]];
		state.failNextInsert = Object.assign(new Error('fk'), { cause: { code: '23503' } });
		const summary = await syncFileReferences(executor, { type: 'post', id: 'post-1' }, [KEY]);
		expect(summary).toMatchObject({ added: 0, missing: 1 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
	});
});

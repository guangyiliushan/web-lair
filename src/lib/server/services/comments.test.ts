import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comments } from '$lib/server/db/content';
import type { CacheStore } from '$lib/server/cache/store';

/**
 * Service tests for the comment P3a read/write paths (ledger §27): the SQL
 * visibility predicate, the pure thread assembly (placeholder/floor rules,
 * chip resolution, truncation) and the submit pipeline (throttle + fail-open
 * contract, owner auto-approve, parent validation, snapshot columns). The db
 * module is mocked with the P2-style recording executor so column choices and
 * guard order have teeth.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		insertResults: [] as unknown[][],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		limits: [] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/cache', () => ({
	getCache: () => {
		throw new Error('tests must pass an explicit cache store');
	}
}));

import {
	assembleThreads,
	loadThreads,
	submitComment,
	visibleCommentCondition,
	COMMENT_MAX_LENGTH,
	THREAD_REPLY_LIMIT,
	THREAD_ROOT_LIMIT,
	type CommentRow
} from './comments';

const TARGET = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';
const GRAND = '33333333-3333-3333-3333-333333333333';
const VIEWER = '44444444-4444-4444-4444-444444444444';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				// Record .limit() caps so dropping one turns the suite red.
				if (prop === 'limit') {
					return (value: unknown) => {
						state.limits.push(value);
						return self;
					};
				}
				return () => self;
			}
		}
	);
	return self;
}

const selectMock = vi.fn(() => makeChain(state.selectQueue.shift() ?? []));
const insertMock = vi.fn((table: unknown) => ({
	values: (values: Record<string, unknown>) => {
		state.inserts.push({ table, values });
		return { returning: async () => state.insertResults.shift() ?? [] };
	}
}));
Object.assign(dbMock, { select: selectMock, insert: insertMock });

beforeEach(() => {
	state.selectQueue = [];
	state.insertResults = [];
	state.inserts = [];
	state.limits = [];
	selectMock.mockClear();
	insertMock.mockClear();
});

function row(overrides: Partial<CommentRow> = {}): CommentRow {
	return {
		id: 'c-root-1',
		text: 'hello',
		author: 'Alice',
		avatar: null,
		state: 'approved',
		isDeleted: false,
		isOwnerReply: false,
		pin: false,
		createdAt: new Date('2026-09-30T10:00:00Z'),
		readerId: VIEWER,
		parentCommentId: null,
		rootCommentId: null,
		...overrides
	};
}

function fakeStore(incr: () => Promise<number>): CacheStore {
	return {
		get: async () => null,
		set: async () => undefined,
		incr
	};
}

const READER = { id: VIEWER, role: 'member' };

describe('visibleCommentCondition', () => {
	it('shows guests approved rows only - and keeps deleted rows in the set', () => {
		const query = new PgDialect().sqlToQuery(visibleCommentCondition('post', TARGET, null));
		expect(query.sql).toContain('"comments"."post_id" = ');
		expect(query.params).toContain(TARGET);
		expect(query.params).toContain('approved');
		expect(query.params).not.toContain('pending');
		expect(query.sql).not.toContain('reader_id');
		// Deleted rows must flow into the assembly (placeholder-vs-drop).
		expect(query.sql).not.toContain('is_deleted');
	});

	it('additionally admits the viewers own pending rows', () => {
		const query = new PgDialect().sqlToQuery(visibleCommentCondition('post', TARGET, VIEWER));
		expect(query.sql).toContain('"comments"."reader_id" = ');
		expect(query.params).toContain('pending');
		expect(query.params).toContain(VIEWER);
		expect(query.params).toContain('approved');
	});

	it('switches the exclusive-arc column per target type', () => {
		expect(new PgDialect().sqlToQuery(visibleCommentCondition('note', TARGET, null)).sql).toContain(
			'"comments"."note_id" = '
		);
		expect(new PgDialect().sqlToQuery(visibleCommentCondition('page', TARGET, null)).sql).toContain(
			'"comments"."page_id" = '
		);
	});
});

describe('assembleThreads', () => {
	it('keeps visible replies, drops deleted ones, derives the count', () => {
		const root = row({ id: 'r1' });
		const alive = row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1', author: 'Bob' });
		const gone = row({
			id: 'p2',
			parentCommentId: 'r1',
			rootCommentId: 'r1',
			author: 'Eve',
			isDeleted: true
		});
		const page = assembleThreads([root], [alive, gone]);
		expect(page.roots).toHaveLength(1);
		expect(page.roots[0].replyCount).toBe(1);
		expect(page.roots[0].replies.map((reply) => reply.id)).toEqual(['p1']);
		expect(page.visibleCount).toBe(2);
	});

	it('keeps a floor placeholder for a deleted root while replies remain', () => {
		const root = row({ id: 'r1', isDeleted: true, author: null, text: '' });
		const reply = row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1' });
		const page = assembleThreads([root], [reply]);
		expect(page.roots).toHaveLength(1);
		expect(page.roots[0].isDeleted).toBe(true);
		expect(page.roots[0].author).toBeNull();
		expect(page.roots[0].text).toBe('');
		// The floor keeps the replies too (spec §7).
		expect(page.roots[0].replies).toHaveLength(1);
		expect(page.roots[0].replyCount).toBe(1);
	});

	it('drops deleted roots without visible replies - and deleted pending roots', () => {
		const orphan = row({ id: 'r1', isDeleted: true });
		const pendingDeleted = row({ id: 'r2', isDeleted: true, state: 'pending' });
		const goneReply = row({
			id: 'p1',
			parentCommentId: 'r1',
			rootCommentId: 'r1',
			isDeleted: true
		});
		const withDeletedReplyOnly = assembleThreads([orphan], [goneReply]);
		expect(withDeletedReplyOnly.roots).toHaveLength(0);
		const withPendingRoot = assembleThreads([pendingDeleted], []);
		expect(withPendingRoot.roots).toHaveLength(0);
	});

	it('marks own pending rows and owner replies', () => {
		const root = row({ id: 'r1', state: 'pending', isOwnerReply: true });
		const page = assembleThreads([root], []);
		expect(page.roots[0].isPending).toBe(true);
		expect(page.roots[0].isOwner).toBe(true);
	});

	it('resolves the reply chip inside the root subtree only', () => {
		const root = row({ id: 'r1', author: 'Alice' });
		const direct = row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1', author: 'Bob' });
		const nested = row({ id: 'p2', parentCommentId: 'p1', rootCommentId: 'r1', author: 'Cara' });
		const toGone = row({ id: 'p3', parentCommentId: 'px', rootCommentId: 'r1', author: 'Dan' });
		const gone = row({
			id: 'px',
			parentCommentId: 'r1',
			rootCommentId: 'r1',
			author: 'Eve',
			isDeleted: true
		});
		const page = assembleThreads([root], [direct, nested, toGone, gone]);
		const chips = Object.fromEntries(
			page.roots[0].replies.map((reply) => [reply.id, reply.replyToAuthor])
		);
		expect(chips['p1']).toBeNull(); // direct reply to the root: no chip
		expect(chips['p2']).toBe('Bob'); // nested: chip names the parent
		expect(chips['p3']).toBeNull(); // parent hidden/deleted: never dangle
	});

	it('passes the truncation flag through', () => {
		expect(assembleThreads([], [], { truncated: true }).truncated).toBe(true);
		expect(assembleThreads([], []).truncated).toBe(false);
	});
});

describe('loadThreads', () => {
	it('reads roots then replies, with the grill caps', async () => {
		state.selectQueue = [
			[row({ id: 'r1' })],
			[row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1' })]
		];
		const page = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		expect(state.limits).toEqual([THREAD_ROOT_LIMIT, THREAD_REPLY_LIMIT]);
		expect(page.roots).toHaveLength(1);
		expect(page.roots[0].replyCount).toBe(1);
	});

	it('skips the reply query entirely when no roots were fetched', async () => {
		state.selectQueue = [[]];
		const page = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: VIEWER });
		expect(page.roots).toEqual([]);
		expect(state.limits).toEqual([THREAD_ROOT_LIMIT]);
	});
});

describe('submitComment', () => {
	function input(overrides: Record<string, unknown> = {}) {
		return {
			targetType: 'post' as const,
			targetId: TARGET,
			text: 'hello world',
			user: READER,
			author: 'Alice',
			avatar: null,
			cache: fakeStore(async () => 1),
			now: new Date('2026-09-30T12:00:00Z'),
			...overrides
		};
	}

	it('stores a readers root comment as pending with the frozen snapshot', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-1', state: 'pending' }]];
		const result = await submitComment(input());
		expect(result).toEqual({ kind: 'created', id: 'new-1', state: 'pending' });
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(comments);
		const values = state.inserts[0].values;
		expect(values).toMatchObject({
			postId: TARGET,
			readerId: VIEWER,
			author: 'Alice',
			avatar: null,
			text: 'hello world',
			state: 'pending',
			isOwnerReply: false,
			parentCommentId: null,
			rootCommentId: null,
			reviewedBy: null,
			reviewedAt: null
		});
		// Spec §1: the non-collected fields must never be written.
		for (const key of ['ip', 'agent', 'location', 'countryCode', 'mail', 'url']) {
			expect(values).not.toHaveProperty(key);
		}
	});

	it('derives the root pointer for replies to a root and to a reply', async () => {
		const base = { id: PARENT, postId: TARGET, state: 'approved', isDeleted: false };

		state.selectQueue = [[{ id: TARGET, allowComment: true }], [{ ...base, rootCommentId: null }]];
		state.insertResults = [[{ id: 'new-2', state: 'pending' }]];
		await submitComment(input({ parentId: PARENT }));
		expect(state.inserts[0].values).toMatchObject({
			parentCommentId: PARENT,
			rootCommentId: PARENT
		});

		state.selectQueue = [[{ id: TARGET, allowComment: true }], [{ ...base, rootCommentId: GRAND }]];
		state.insertResults = [[{ id: 'new-3', state: 'pending' }]];
		await submitComment(input({ parentId: PARENT }));
		expect(state.inserts.at(-1)?.values).toMatchObject({ rootCommentId: GRAND });
	});

	it('auto-approves owner/admin posts and skips their throttle', async () => {
		const incr = vi.fn(async () => 1);
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-4', state: 'approved' }]];
		const now = new Date('2026-09-30T12:00:00Z');
		const result = await submitComment(
			input({ user: { id: 'o1', role: 'owner' }, author: 'Owner', cache: fakeStore(incr), now })
		);
		expect(incr).not.toHaveBeenCalled();
		expect(result).toEqual({ kind: 'created', id: 'new-4', state: 'approved' });
		expect(state.inserts[0].values).toMatchObject({
			state: 'approved',
			isOwnerReply: true,
			reviewedBy: 'o1',
			reviewedAt: now
		});
	});

	it('blocks the third submission in the window before any db work', async () => {
		const incr = vi.fn(async () => 3);
		const result = await submitComment(input({ cache: fakeStore(incr) }));
		expect(result).toEqual({ kind: 'throttled', windowSeconds: 60 });
		expect(incr).toHaveBeenCalledTimes(1);
		expect(selectMock).not.toHaveBeenCalled();
		expect(state.inserts).toHaveLength(0);
	});

	it('stays fail-open when the cache store is down (T14 contract)', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-5', state: 'pending' }]];
		const result = await submitComment(
			input({
				cache: fakeStore(async () => {
					throw new Error('valkey down');
				})
			})
		);
		expect(result).toEqual({ kind: 'created', id: 'new-5', state: 'pending' });
	});

	it('rejects empty and oversized texts by code points, without db work', async () => {
		expect(await submitComment(input({ text: '   ' }))).toEqual({ kind: 'empty' });
		expect(await submitComment(input({ text: 'a'.repeat(COMMENT_MAX_LENGTH + 1) }))).toEqual({
			kind: 'too-long',
			max: COMMENT_MAX_LENGTH
		});
		expect(await submitComment(input({ text: '👍'.repeat(COMMENT_MAX_LENGTH + 1) }))).toEqual({
			kind: 'too-long',
			max: COMMENT_MAX_LENGTH
		});
		// Exactly at the cap (2 code points per emoji) is fine.
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-6', state: 'pending' }]];
		const longText = '👍'.repeat(COMMENT_MAX_LENGTH);
		await submitComment(input({ text: longText }));
		expect(state.inserts[0].values.text).toBe(longText);
	});

	it('refuses invisible targets, closed threads and malformed ids', async () => {
		state.selectQueue = [[]];
		expect(await submitComment(input())).toEqual({ kind: 'target-unavailable' });

		state.selectQueue = [[{ id: TARGET, allowComment: false }]];
		expect(await submitComment(input())).toEqual({ kind: 'target-unavailable' });

		selectMock.mockClear();
		expect(await submitComment(input({ targetId: 'not-a-uuid' }))).toEqual({
			kind: 'target-unavailable'
		});
		expect(selectMock).not.toHaveBeenCalled();
		expect(state.inserts).toHaveLength(0);
	});

	it('refuses replies whose parent is missing, foreign, pending or deleted', async () => {
		const cases: Array<Array<unknown>> = [
			[[]],
			[[{ id: PARENT, postId: GRAND, state: 'approved', isDeleted: false }]],
			[[{ id: PARENT, postId: TARGET, state: 'pending', isDeleted: false }]],
			[[{ id: PARENT, postId: TARGET, state: 'approved', isDeleted: true }]]
		];
		for (const parentRows of cases) {
			state.selectQueue = [[{ id: TARGET, allowComment: true }], parentRows];
			expect(await submitComment(input({ parentId: PARENT }))).toEqual({
				kind: 'parent-unavailable'
			});
		}
		expect(state.inserts).toHaveLength(0);

		selectMock.mockClear();
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		expect(await submitComment(input({ parentId: 'nope' }))).toEqual({
			kind: 'parent-unavailable'
		});
		expect(selectMock).toHaveBeenCalledTimes(1); // target check only
	});

	it('fails closed on targets this batch does not serve yet', async () => {
		const incr = vi.fn(async () => 1);
		const result = await submitComment(input({ targetType: 'note', cache: fakeStore(incr) }));
		expect(result).toEqual({ kind: 'unsupported-target' });
		expect(incr).not.toHaveBeenCalled();
		expect(selectMock).not.toHaveBeenCalled();
	});
});

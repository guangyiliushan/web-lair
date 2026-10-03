import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comments } from '$lib/server/db/content';
import { COMMENT_MAX_LENGTH } from '$lib/components/comments/types';
import type { CacheStore } from '$lib/server/cache/store';

/**
 * Service tests for the comment P3a read/write paths (ledger §27): the SQL
 * visibility predicate, the pure thread assembly (placeholder/floor rules,
 * chip resolution, truncation probe) and the submit pipeline (verification
 * gate, throttle + fail-open contract, owner auto-approve, parent
 * validation, snapshot sanitising, FK-race mapping). The db module is mocked
 * with the P2-style recording executor: `where`/`orderBy`/`limit` clauses are
 * captured so guard conditions, ordering and caps have teeth.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		insertResults: [] as unknown[][],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		limits: [] as unknown[],
		wheres: [] as unknown[][],
		orderBys: [] as unknown[][],
		failWith: undefined as unknown
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
	COMMENT_RATE_LIMIT,
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
				// Record the query clauses so dropping a guard or a cap turns
				// the suite red.
				if (prop === 'limit') {
					return (value: unknown) => {
						state.limits.push(value);
						return self;
					};
				}
				if (prop === 'where') {
					return (...args: unknown[]) => {
						state.wheres.push(args);
						return self;
					};
				}
				if (prop === 'orderBy') {
					return (...args: unknown[]) => {
						state.orderBys.push(args);
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
		return {
			returning: async () => {
				if (state.failWith) throw state.failWith;
				return state.insertResults.shift() ?? [];
			}
		};
	}
}));
Object.assign(dbMock, { select: selectMock, insert: insertMock });

beforeEach(() => {
	state.selectQueue = [];
	state.insertResults = [];
	state.inserts = [];
	state.limits = [];
	state.wheres = [];
	state.orderBys = [];
	state.failWith = undefined;
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

const READER = { id: VIEWER, role: 'member', emailVerified: true };

function render(sql: unknown): ReturnType<PgDialect['sqlToQuery']> {
	return new PgDialect().sqlToQuery(sql as SQL);
}

describe('visibleCommentCondition', () => {
	it('shows guests approved rows only - and keeps deleted rows in the set', () => {
		const query = render(visibleCommentCondition('post', TARGET, null));
		expect(query.sql).toContain('"comments"."post_id" = ');
		expect(query.params).toContain(TARGET);
		expect(query.params).toContain('approved');
		expect(query.params).not.toContain('pending');
		expect(query.sql).not.toContain('reader_id');
		// Deleted rows must flow into the assembly (placeholder-vs-drop).
		expect(query.sql).not.toContain('is_deleted');
	});

	it('additionally admits the viewers own pending rows', () => {
		const query = render(visibleCommentCondition('post', TARGET, VIEWER));
		expect(query.sql).toContain('"comments"."reader_id" = ');
		expect(query.params).toContain('pending');
		expect(query.params).toContain(VIEWER);
		expect(query.params).toContain('approved');
	});

	it('switches the exclusive-arc column per target type', () => {
		expect(render(visibleCommentCondition('note', TARGET, null)).sql).toContain(
			'"comments"."note_id" = '
		);
		expect(render(visibleCommentCondition('page', TARGET, null)).sql).toContain(
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
	});

	it('drops deleted roots without visible replies', () => {
		const orphan = row({ id: 'r1', isDeleted: true });
		const goneReply = row({
			id: 'p1',
			parentCommentId: 'r1',
			rootCommentId: 'r1',
			isDeleted: true
		});
		const withDeletedReplyOnly = assembleThreads([orphan], [goneReply]);
		expect(withDeletedReplyOnly.roots).toHaveLength(0);
	});

	it('drops a deleted pending root even when visible replies exist', () => {
		// The placeholder rule requires isDeleted && state==='approved' && replies>0;
		// this input discriminates the state half-condition (unreachable through
		// today's write path, but the semantics are pinned).
		const pendingDeleted = row({ id: 'r2', isDeleted: true, state: 'pending' });
		const reply = row({ id: 'p1', parentCommentId: 'r2', rootCommentId: 'r2' });
		expect(assembleThreads([pendingDeleted], [reply]).roots).toHaveLength(0);
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
	it('pins the spec literals (grill Q6 / spec §1)', () => {
		expect(THREAD_ROOT_LIMIT).toBe(200);
		expect(THREAD_REPLY_LIMIT).toBe(500);
		expect(COMMENT_MAX_LENGTH).toBe(2000);
		expect(COMMENT_RATE_LIMIT).toEqual({ limit: 2, windowSeconds: 60 });
	});

	it('reads roots then replies, with the grill caps plus the probe row', async () => {
		state.selectQueue = [
			[row({ id: 'r1' })],
			[row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1' })]
		];
		const page = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		// Literal caps, not the constants: a drifted constant must fail here.
		expect(state.limits).toEqual([201, 501]);
		// The roots query really is parent IS NULL (replies must not become
		// roots in the assembly).
		expect(render(state.wheres[0]?.[0]).sql).toContain('"comments"."parent_comment_id" is null');
		expect(page.roots).toHaveLength(1);
		expect(page.roots[0].replies).toHaveLength(1);
	});

	it('skips the reply query entirely when no roots were fetched', async () => {
		state.selectQueue = [[]];
		const page = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: VIEWER });
		expect(page.roots).toEqual([]);
		expect(state.limits).toEqual([THREAD_ROOT_LIMIT + 1]);
	});

	it('flags truncation via the +1 probe and slices the page back to the cap', async () => {
		const manyRoots = Array.from({ length: THREAD_ROOT_LIMIT + 1 }, (_, index) =>
			row({ id: `r${index}` })
		);
		state.selectQueue = [manyRoots, []];
		const page = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		expect(page.truncated).toBe(true);
		expect(page.roots).toHaveLength(THREAD_ROOT_LIMIT);

		// A full page WITHOUT an extra row is not truncated (no false positive).
		state.selectQueue = [[row({ id: 'r1' })], []];
		const exact = await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		expect(exact.truncated).toBe(false);
	});

	it('orders roots pinned-first then oldest-first (SQL teeth)', async () => {
		state.selectQueue = [[row({ id: 'r1' })]];
		await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		const [pinArg, createdArg] = state.orderBys[0] as [SQL, SQL];
		expect(render(pinArg).sql).toContain('"comments"."pin" desc');
		expect(render(createdArg).sql).toContain('"comments"."created_at" asc');
	});

	it('excludes deleted replies in SQL so they cannot spend the row budget', async () => {
		state.selectQueue = [
			[row({ id: 'r1' })],
			[row({ id: 'p1', parentCommentId: 'r1', rootCommentId: 'r1' })]
		];
		await loadThreads({ targetType: 'post', targetId: TARGET, viewerId: null });
		const repliesWhere = state.wheres[1]?.[0];
		expect(render(repliesWhere).sql).toContain('"comments"."is_deleted" = ');
	});
});

describe('submitComment', () => {
	function input(overrides: Record<string, unknown> = {}) {
		return {
			targetType: 'post' as const,
			targetId: TARGET,
			lang: 'en',
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
		const result = await submitComment(input({ avatar: 'https://cdn.example/a.png' }));
		expect(result).toEqual({ kind: 'created', id: 'new-1', state: 'pending' });
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(comments);
		const values = state.inserts[0].values;
		expect(values).toMatchObject({
			postId: TARGET,
			readerId: VIEWER,
			author: 'Alice',
			avatar: 'https://cdn.example/a.png',
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

	it('re-checks the target against id + lang + visibility (SQL teeth)', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-sql', state: 'pending' }]];
		await submitComment(input());
		const query = render(state.wheres[0]?.[0]);
		expect(query.sql).toContain('"posts"."id" = ');
		expect(query.sql).toContain('"posts"."lang" = ');
		expect(query.sql).toContain('"posts"."status" in ');
		expect(query.sql).toContain('"posts"."published_at" <= ');
		expect(query.params).toContain('en');
		expect(query.params).toContain('published');
		expect(query.params).toContain('scheduled');
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
			input({
				user: { id: 'o1', role: 'owner', emailVerified: true },
				author: 'Owner',
				cache: fakeStore(incr),
				now
			})
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

	it('blocks the third submission inside the window, after validation', async () => {
		const incr = vi.fn(async () => 3);
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		const result = await submitComment(input({ cache: fakeStore(incr) }));
		expect(result).toEqual({ kind: 'throttled', windowSeconds: 60 });
		expect(incr).toHaveBeenCalledTimes(1);
		expect(state.inserts).toHaveLength(0); // nothing was written
	});

	it('does not spend the window on validation failures', async () => {
		const incr = vi.fn(async () => 1);
		state.selectQueue = [[]];
		expect(await submitComment(input({ cache: fakeStore(incr) }))).toEqual({
			kind: 'target-unavailable'
		});
		expect(incr).not.toHaveBeenCalled();
	});

	it('stays fail-open when the cache store is down (T14) and says so', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing open'));
		warn.mockRestore();
	});

	it('fails closed for unverified readers before anything else', async () => {
		const incr = vi.fn(async () => 1);
		const result = await submitComment(
			input({
				user: { id: VIEWER, role: 'member', emailVerified: false },
				cache: fakeStore(incr)
			})
		);
		expect(result).toEqual({ kind: 'unverified' });
		expect(incr).not.toHaveBeenCalled();
		expect(selectMock).not.toHaveBeenCalled();
		expect(state.inserts).toHaveLength(0);
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

	it('strips zero-width/bidi characters before validating and storing', async () => {
		// An invisible-only "comment" must not pass the empty gate.
		expect(await submitComment(input({ text: '\u200b\u200b\u200b' }))).toEqual({ kind: 'empty' });
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-7', state: 'pending' }]];
		await submitComment(input({ text: 'hi\u200b\u200f there' }));
		expect(state.inserts[0].values.text).toBe('hi there');
	});

	it('sanitises the frozen author/avatar snapshot', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-8', state: 'pending' }]];
		await submitComment(
			input({
				author: ` \u202eBad\u202c${'x'.repeat(100)}`,
				avatar: 'data:image/svg+xml,<svg></svg>'
			})
		);
		const values = state.inserts[0].values;
		expect(String(values.author).length).toBeLessThanOrEqual(64);
		expect(values.author).not.toContain('\u202e');
		expect(values.avatar).toBeNull();

		// A long but valid http(s) avatar is also refused above the cap.
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'new-9', state: 'pending' }]];
		await submitComment(input({ avatar: `https://cdn.example/${'a'.repeat(600)}.png` }));
		expect(state.inserts.at(-1)?.values.avatar).toBeNull();
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

	it('maps a vanished target/parent (FK 23503) to unavailable instead of a 500', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.failWith = { cause: { code: '23503' } };
		expect(await submitComment(input())).toEqual({ kind: 'target-unavailable' });

		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.failWith = { cause: { code: '42P01' } };
		await expect(submitComment(input())).rejects.toMatchObject({ cause: { code: '42P01' } });
	});

	it('fails closed on targets this batch does not serve yet (pages)', async () => {
		const incr = vi.fn(async () => 1);
		const result = await submitComment(input({ targetType: 'page', cache: fakeStore(incr) }));
		expect(result).toEqual({ kind: 'unsupported-target' });
		expect(incr).not.toHaveBeenCalled();
		expect(selectMock).not.toHaveBeenCalled();
	});
});

describe('submitComment note targets (N1)', () => {
	function noteInput(overrides: Record<string, unknown> = {}) {
		return {
			targetType: 'note' as const,
			targetId: TARGET,
			lang: 'en',
			text: 'note comment',
			user: READER,
			author: 'Alice',
			avatar: null,
			cache: fakeStore(async () => 1),
			now: new Date('2026-09-30T12:00:00Z'),
			...overrides
		};
	}

	it('stores a root comment against the note arc', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'n-1', state: 'pending' }]];
		const result = await submitComment(noteInput());
		expect(result).toEqual({ kind: 'created', id: 'n-1', state: 'pending' });
		expect(state.inserts[0].values).toMatchObject({ noteId: TARGET, readerId: VIEWER });
		// Exclusive arc: the post column must stay untouched.
		expect(state.inserts[0].values).not.toHaveProperty('postId');
	});

	it('refuses a note that is not commentable', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: false }]];
		expect(await submitComment(noteInput())).toEqual({ kind: 'target-unavailable' });
		expect(state.inserts).toHaveLength(0);
	});

	it('refuses a password-gated note (the target query excludes it)', async () => {
		// The service predicate adds `isNull(password_hash)`: a gated row
		// never comes back from the target check at all.
		state.selectQueue = [[]];
		expect(await submitComment(noteInput())).toEqual({ kind: 'target-unavailable' });
	});

	it('re-checks the note target against id + lang + visibility + the gate (SQL teeth)', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'n-sql', state: 'pending' }]];
		await submitComment(noteInput());
		const query = render(state.wheres[0]?.[0]);
		expect(query.sql).toContain('"notes"."id" = ');
		expect(query.sql).toContain('"notes"."lang" = ');
		expect(query.sql).toContain('"notes"."status" in ');
		expect(query.sql).toContain('"notes"."published_at" <= ');
		// Fail-closed default: no explicit unlock signal, the gate stays in.
		expect(query.sql).toContain('"notes"."password_hash" is null');
	});

	it('drops the gate clause ONLY for requests carrying unlockVerified', async () => {
		state.selectQueue = [[{ id: TARGET, allowComment: true }]];
		state.insertResults = [[{ id: 'n-open', state: 'pending' }]];
		const result = await submitComment(noteInput({ unlockVerified: true }));
		expect(result).toEqual({ kind: 'created', id: 'n-open', state: 'pending' });
		const query = render(state.wheres[0]?.[0]);
		expect(query.sql).not.toContain('"notes"."password_hash" is null');
		// The rest of the authoritative re-check is untouched.
		expect(query.sql).toContain('"notes"."id" = ');
		expect(query.sql).toContain('"notes"."lang" = ');
	});

	it('derives reply pointers against the note arc', async () => {
		state.selectQueue = [
			[{ id: TARGET, allowComment: true }],
			[{ id: PARENT, postId: null, noteId: TARGET, state: 'approved', isDeleted: false }]
		];
		state.insertResults = [[{ id: 'n-2', state: 'pending' }]];
		await submitComment(noteInput({ parentId: PARENT }));
		expect(state.inserts[0].values).toMatchObject({
			noteId: TARGET,
			parentCommentId: PARENT,
			rootCommentId: PARENT
		});
	});

	it('rejects a reply whose parent sits on a different note', async () => {
		state.selectQueue = [
			[{ id: TARGET, allowComment: true }],
			[
				{
					id: PARENT,
					postId: null,
					noteId: '66666666-6666-6666-6666-666666666666',
					state: 'approved',
					isDeleted: false
				}
			]
		];
		expect(await submitComment(noteInput({ parentId: PARENT }))).toEqual({
			kind: 'parent-unavailable'
		});
		expect(state.inserts).toHaveLength(0);
	});
});

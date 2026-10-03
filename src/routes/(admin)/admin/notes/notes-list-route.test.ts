import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Route-level tests for the N1 admin notes list (batch 5): filter guards
 * (status whitelist, uuid topic guard, keyword ilike), page clamping, the
 * "有未发布改动" badge merge and the admin guard. The db module is mocked
 * with a recording chain so a dropped WHERE / wrong clamp turns red.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		whereArgs: [] as unknown[],
		limitArgs: [] as unknown[],
		offsetArgs: [] as unknown[]
	},
	service: {
		draftsForNotes: vi.fn(async () => new Set<string>()),
		requireAdminRole: vi.fn()
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/server/services/note-drafts', () => ({
	draftsForNotes: service.draftsForNotes
}));

import { load } from './+page.server';

const NOTE_ID = '11111111-1111-1111-1111-111111111111';
const TOPIC_ID = '33333333-3333-3333-3333-333333333333';
const dialect = new PgDialect();

function chain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: (...args: unknown[]) => {
			state.whereArgs.push(args[0]);
			return c;
		},
		leftJoin: ret,
		orderBy: ret,
		limit: (...args: unknown[]) => {
			state.limitArgs.push(args[0]);
			return c;
		},
		offset: (...args: unknown[]) => {
			state.offsetArgs.push(args[0]);
			return c;
		},
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

const NOTE_ROW = {
	id: NOTE_ID,
	nid: 7,
	title: 'First note',
	slug: 'first-note',
	lang: 'en',
	status: 'published',
	mood: null,
	weatherCode: null,
	temperatureC: null,
	readCount: 3,
	likeCount: 1,
	topicId: TOPIC_ID,
	topicName: '旅行',
	pinned: false,
	locked: false,
	createdAt: new Date('2026-09-01T00:00:00Z'),
	updatedAt: new Date('2026-09-02T00:00:00Z'),
	publishedAt: new Date('2026-09-01T00:00:00Z')
};

function event(query: string) {
	return {
		url: new URL(`http://localhost/admin/notes${query}`),
		locals: { admin: { userId: 'u1' }, user: { id: 'u1' } }
	} as never;
}

describe('admin notes list route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectQueue = [];
		state.whereArgs = [];
		state.limitArgs = [];
		state.offsetArgs = [];
		dbMock.select = () => chain();
		service.draftsForNotes.mockResolvedValue(new Set<string>());
	});

	it('guards the load with requireAdminRole', async () => {
		state.selectQueue = [[], [{ count: 0 }], []];
		await load(event(''));
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
	});

	it('applies whitelisted filters only and renders them in SQL', async () => {
		state.selectQueue = [[NOTE_ROW], [{ count: 1 }], []];
		await load(event(`?status=trash&topic=${TOPIC_ID}&keyword=hello`));

		// First select = the rows query.
		const rendered = dialect.sqlToQuery(state.whereArgs[0] as SQL);
		expect(rendered.sql).toContain('"notes"."status" =');
		expect(rendered.sql).toContain('"notes"."topic_id" =');
		expect(rendered.sql).toContain('"notes"."title" ilike');
		expect(rendered.params).toContain('trash');
		expect(rendered.params).toContain(TOPIC_ID);
		expect(rendered.params).toContain('%hello%');

		// An unknown status and a malformed topic must NOT filter at all
		// (the chain still calls .where(undefined), so filter those out).
		state.whereArgs = [];
		state.selectQueue = [[], [{ count: 0 }], []];
		await load(event('?status=scheduled&topic=not-a-uuid'));
		expect(state.whereArgs.filter((arg) => arg !== undefined)).toHaveLength(0);
	});

	it('clamps the page parameter and pages by 20', async () => {
		state.selectQueue = [[], [{ count: 0 }], []];
		await load(event('?page=5'));
		expect(state.limitArgs).toContain(20);
		expect(state.offsetArgs).toContain(80);

		for (const badPage of ['abc', '0', '-3', 'Infinity', '2.5']) {
			state.limitArgs = [];
			state.offsetArgs = [];
			state.selectQueue = [[], [{ count: 0 }], []];
			await load(event(`?page=${badPage}`));
			expect(state.offsetArgs, badPage).toContain(0);
		}

		// Legal pages are clamped to the 10k ceiling (1e9 → 10000).
		state.limitArgs = [];
		state.offsetArgs = [];
		state.selectQueue = [[], [{ count: 0 }], []];
		await load(event('?page=1e9'));
		expect(state.offsetArgs).toContain((10_000 - 1) * 20);
	});

	it('merges the pending-draft badge and echoes filters/actions', async () => {
		state.selectQueue = [
			[NOTE_ROW, { ...NOTE_ROW, id: '22222222-2222-2222-2222-222222222222' }],
			[{ count: 2 }],
			[{ id: TOPIC_ID, name: '旅行', slug: 'travel' }]
		];
		service.draftsForNotes.mockResolvedValue(new Set([NOTE_ID]));

		const result = (await load(event('?status=published'))) as unknown as {
			notes: { id: string; hasDraft: boolean }[];
			totalCount: number;
			page: number;
			filters: Record<string, string>;
			headerActions: { href: string }[];
			topics: unknown[];
		};
		expect(result.notes.find((n) => n.id === NOTE_ID)?.hasDraft).toBe(true);
		expect(result.notes[1].hasDraft).toBe(false);
		expect(result.totalCount).toBe(2);
		expect(result.page).toBe(1);
		expect(result.filters).toMatchObject({ status: 'published' });
		expect(result.headerActions.map((a) => a.href)).toEqual([
			'/admin/notes/topics',
			'/admin/notes/edit'
		]);
	});
});

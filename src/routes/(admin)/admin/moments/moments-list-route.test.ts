import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Route-level tests for the admin moments list (batch: shared list surface).
 * The list now answers the same contract as the posts / notes admin lists -
 * kind whitelist, keyword ilike, page clamping, real count - so a dropped
 * WHERE or a widened whitelist turns red here. The db module is mocked with
 * the same recording chain the notes list spec uses.
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
		requireAdminRole: vi.fn()
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));

import { load } from './+page.server';

const MOMENT_ID = '44444444-4444-4444-4444-444444444444';
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

const MOMENT_ROW = {
	id: MOMENT_ID,
	content: 'a fragment of the day',
	type: 'tech',
	up: 2,
	down: 0,
	createdAt: new Date('2026-10-01T00:00:00Z')
};

function event(query: string) {
	return {
		url: new URL(`http://localhost/admin/moments${query}`),
		locals: { admin: { userId: 'u1' }, user: { id: 'u1' } }
	} as never;
}

describe('admin moments list route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectQueue = [];
		state.whereArgs = [];
		state.limitArgs = [];
		state.offsetArgs = [];
		dbMock.select = () => chain();
	});

	it('guards the load with requireAdminRole', async () => {
		state.selectQueue = [[], [{ count: 0 }]];
		await load(event(''));
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
	});

	it('applies whitelisted filters only and renders them in SQL', async () => {
		state.selectQueue = [[MOMENT_ROW], [{ count: 1 }]];
		await load(event('?type=tech&keyword=fragment'));

		const rendered = dialect.sqlToQuery(state.whereArgs[0] as SQL);
		expect(rendered.sql).toContain('"moments"."type" =');
		expect(rendered.sql).toContain('"moments"."content" ilike');
		expect(rendered.params).toContain('tech');
		expect(rendered.params).toContain('%fragment%');

		// An unknown kind must NOT filter at all (the chain still calls
		// .where(undefined), so filter those out).
		state.whereArgs = [];
		state.selectQueue = [[], [{ count: 0 }]];
		await load(event('?type=bogus'));
		expect(state.whereArgs.filter((arg) => arg !== undefined)).toHaveLength(0);
	});

	it('clamps the page parameter and pages by 20', async () => {
		state.selectQueue = [[], [{ count: 0 }]];
		await load(event('?page=5'));
		expect(state.limitArgs).toContain(20);
		expect(state.offsetArgs).toContain(80);

		for (const badPage of ['abc', '0', '-3', 'Infinity', '2.5']) {
			state.limitArgs = [];
			state.offsetArgs = [];
			state.selectQueue = [[], [{ count: 0 }]];
			await load(event(`?page=${badPage}`));
			expect(state.offsetArgs, badPage).toContain(0);
		}

		// Legal pages are clamped to the 10k ceiling (1e9 → 10000).
		state.limitArgs = [];
		state.offsetArgs = [];
		state.selectQueue = [[], [{ count: 0 }]];
		await load(event('?page=1e9'));
		expect(state.offsetArgs).toContain((10_000 - 1) * 20);
	});

	it('echoes rows, count, filters and the header action', async () => {
		state.selectQueue = [
			[MOMENT_ROW, { ...MOMENT_ROW, id: '55555555-5555-5555-5555-555555555555' }],
			[{ count: 2 }]
		];

		const result = (await load(event('?type=life'))) as unknown as {
			moments: { id: string; excerpt?: string }[];
			totalCount: number;
			page: number;
			pageSize: number;
			filters: Record<string, string>;
			kinds: readonly string[];
			headerActions: { actionId?: string; href?: string }[];
		};
		expect(result.moments).toHaveLength(2);
		expect(result.totalCount).toBe(2);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(20);
		expect(result.filters).toMatchObject({ type: 'life' });
		expect([...result.kinds]).toEqual(['life', 'tech', 'media', 'other']);
		// The editor is a route now: the header action is a plain link, not a
		// dialog bound through the action registry.
		expect(result.headerActions.map((a) => a.href)).toEqual(['/admin/moments/edit']);
		expect(result.headerActions[0]?.actionId).toBeUndefined();
		expect(result.moments[0]?.excerpt).toBe('a fragment of the day');
	});

	it('forwards the dashboard write deep link to the editor route', async () => {
		state.selectQueue = [[], [{ count: 0 }]];
		await expect(load(event('?add=1'))).rejects.toMatchObject({
			status: 303,
			location: '/admin/moments/edit'
		});
	});

	it('strips markdown markers from the table preview', async () => {
		state.selectQueue = [
			[
				{
					...MOMENT_ROW,
					content: '## 今天\n\n- 一条 **粗体**，见 [链接](https://x.test)'
				}
			],
			[{ count: 1 }]
		];
		const result = (await load(event(''))) as unknown as {
			moments: { excerpt: string }[];
		};
		expect(result.moments[0]?.excerpt).toBe('今天 一条 粗体，见 链接');
	});
});

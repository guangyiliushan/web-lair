import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the timeline page (P3-b + N1): the stream merges
 * visible posts and notes of the locale (newest first; notes carry their
 * lock marker); `?type=post` / `?type=note` filter the stream; unknown
 * params (e.g. `memory`) fall back to the full stream. The WHERE clauses
 * are inspected through drizzle's own dialect so the locale filter and the
 * visibility predicates have teeth.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], whereArgs: [] as unknown[] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'UTC')
}));

import { load } from './+page.server';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (...args: unknown[]) => {
					if (prop === 'where') state.whereArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

function makeEvent(type?: string) {
	return { url: new URL(`http://localhost/en/timeline${type ? `?type=${type}` : ''}`) } as never;
}

describe('timeline page', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.whereArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('merges visible posts and notes, newest first', async () => {
		state.selectResults = [
			[{ slug: 'p1', title: 'One', publishedAt: new Date(2026, 0, 15, 12) }],
			[
				{
					id: 'n1',
					slug: 'trip',
					title: 'Trip',
					publishedAt: new Date(2026, 1, 1, 12),
					tz: null,
					passwordHash: '$argon2id$stub'
				}
			]
		];

		const data = (await load(makeEvent())) as {
			type: string;
			items: { kind: string; slug: string; title: string; date: string; locked: boolean }[];
		};

		expect(data.type).toBe('all');
		expect(data.items).toEqual([
			{ kind: 'note', slug: 'trip', title: 'Trip', date: 'February 1, 2026', locked: true },
			{ kind: 'post', slug: 'p1', title: 'One', date: 'January 15, 2026', locked: false }
		]);

		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"posts"."lang"');
		expect(sql).toContain('"posts"."status"');
		expect(params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));

		const notesSql = dialect.sqlToQuery(state.whereArgs[1] as never).sql;
		expect(notesSql).toContain('"notes"."lang"');
		expect(notesSql).toContain('"notes"."status"');
	});

	it('streams the post stream for ?type=post', async () => {
		state.selectResults = [[{ slug: 'p1', title: 'One', publishedAt: new Date(2026, 0, 15, 12) }]];

		const data = (await load(makeEvent('post'))) as {
			type: string;
			items: { kind: string; slug: string; title: string; date: string }[];
		};

		expect(data.type).toBe('post');
		expect(data.items).toEqual([
			{ kind: 'post', slug: 'p1', title: 'One', date: 'January 15, 2026', locked: false }
		]);
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});

	it('streams notes for ?type=note (lock marker carried)', async () => {
		state.selectResults = [
			[
				{
					id: 'n1',
					slug: 'trip',
					title: 'Trip',
					publishedAt: new Date(2026, 1, 1, 12),
					tz: null,
					passwordHash: '$argon2id$stub'
				}
			]
		];

		const data = (await load(makeEvent('note'))) as {
			type: string;
			items: { kind: string; slug: string; locked: boolean }[];
		};

		expect(data.type).toBe('note');
		expect(data.items).toEqual([
			{ kind: 'note', slug: 'trip', title: 'Trip', date: 'February 1, 2026', locked: true }
		]);
		expect(dbMock.select).toHaveBeenCalledTimes(1);

		const notesSql = dialect.sqlToQuery(state.whereArgs[0] as never).sql;
		expect(notesSql).toContain('"notes"."status"');
	});

	it('treats unknown params (memory etc.) as the full stream', async () => {
		state.selectResults = [[], []];

		const data = (await load(makeEvent('memory'))) as { type: string };

		expect(data.type).toBe('all');
		expect(dbMock.select).toHaveBeenCalledTimes(2);
	});

	it('orders equal timestamps deterministically (notes before posts)', async () => {
		const at = new Date(2026, 0, 15, 12);
		state.selectResults = [
			[{ slug: 'p2', title: 'Post P', publishedAt: at }],
			[{ id: 'n1', slug: 'p1', title: 'Note P', publishedAt: at, tz: null, passwordHash: null }]
		];

		const data = (await load(makeEvent())) as { items: { title: string }[] };

		// Tie-break chain: time desc, then kind ('note' < 'post'), then slug.
		expect(data.items.map((item) => item.title)).toEqual(['Note P', 'Post P']);
	});
});

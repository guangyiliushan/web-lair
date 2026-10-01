import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the tag detail (P3-b): unknown tag 404, locale +
 * visibility filtering of the post list, localized dates. The db module is
 * mocked with a queue of select results; the second WHERE clause is
 * inspected through drizzle's own dialect.
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
					// Append across chains: chain 1 = tag lookup, chain 2 = posts.
					if (prop === 'where') state.whereArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('tag detail', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.whereArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('404s for an unknown tag', async () => {
		state.selectResults = [[]];
		await expect(load({ params: { slug: 'ghost' } } as never)).rejects.toMatchObject({
			status: 404
		});
	});

	it('lists visible posts of the locale for the tag with localized dates', async () => {
		state.selectResults = [
			[{ id: 't1', name: 'AI', slug: 'ai' }],
			[{ slug: 'p1', title: 'One', publishedAt: new Date(2026, 0, 15, 12) }]
		];

		const data = (await load({ params: { slug: 'ai' } } as never)) as {
			tag: { name: string; slug: string };
			posts: { slug: string; title: string; date: string }[];
		};

		expect(data.tag).toEqual({ name: 'AI', slug: 'ai' });
		expect(data.posts).toEqual([{ slug: 'p1', title: 'One', date: 'January 15, 2026' }]);

		const { sql, params } = dialect.sqlToQuery(state.whereArgs[1] as never);
		expect(sql).toContain('"posts"."lang"');
		expect(sql).toContain('"posts"."status"');
		expect(params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the tags index (P3-b). The db module is mocked with
 * a queue of select results; the posts JOIN condition is inspected through
 * drizzle's own dialect so the locale filter and the shared visibility
 * predicate cannot silently change.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], joinArgs: [] as unknown[][] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => 'en' }));

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
					if (prop === 'innerJoin') state.joinArgs.push(args);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('tags index', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.joinArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('maps counts and filters to the locale visible set', async () => {
		state.selectResults = [
			[
				{ id: 't1', name: 'AI', slug: 'ai', total: 4 },
				{ id: 't2', name: 'Web', slug: 'web', total: 1 }
			]
		];

		const data = (await load({} as never)) as {
			tags: { name: string; slug: string; total: number }[];
		};

		expect(data.tags).toEqual([
			{ name: 'AI', slug: 'ai', total: 4 },
			{ name: 'Web', slug: 'web', total: 1 }
		]);

		// The visibility predicate lives in the posts JOIN condition; find it
		// by content so a join reorder cannot fake a failure (review finding).
		const postsJoin = state.joinArgs
			.map((args) => dialect.sqlToQuery(args[1] as never))
			.find((query) => query.sql.includes('"posts"."lang"'));
		expect(postsJoin).toBeDefined();
		expect(postsJoin!.sql).toContain('"posts"."status"');
		expect(postsJoin!.params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));
	});
});

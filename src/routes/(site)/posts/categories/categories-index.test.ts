import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the categories index (P3-b). The db module is mocked
 * with a queue of select results; the JOIN condition is inspected through
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

describe('categories index', () => {
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
				{ id: 'c1', name: 'Tech', slug: 'tech', description: null, total: 3 },
				{ id: 'c2', name: 'Life', slug: 'life', description: 'Daily', total: 1 }
			]
		];

		const data = (await load({} as never)) as {
			categories: { name: string; slug: string; description: string | null; total: number }[];
		};

		expect(data.categories).toEqual([
			{ name: 'Tech', slug: 'tech', description: null, total: 3 },
			{ name: 'Life', slug: 'life', description: 'Daily', total: 1 }
		]);

		// The visibility predicate lives in the posts JOIN condition.
		const condition = dialect.sqlToQuery(state.joinArgs[0]?.[1] as never);
		expect(condition.sql).toContain('"posts"."lang"');
		expect(condition.sql).toContain('"posts"."status"');
		expect(condition.params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));
	});
});

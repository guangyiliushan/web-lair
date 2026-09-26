import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the site category page (P1 review: the only public DB
 * read path had zero coverage). The db module is mocked with a queue of
 * select results; the WHERE clause is inspected through drizzle's own dialect
 * so the visibility predicate cannot silently change.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		category: null as Record<string, unknown> | null,
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

import { load } from './+page.server';

function makeChain(result: unknown[]) {
	let callIndex = -1;
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (...args: unknown[]) => {
					if (prop === 'where') {
						callIndex += 1;
						state.whereArgs[callIndex] = args[0];
					}
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('site category page', () => {
	beforeEach(() => {
		state.category = { id: 'cat-1', name: 'Svelte', slug: 'svelte' };
		state.selectResults = [[], []];
		state.whereArgs = [];
		Object.assign(dbMock, {
			query: { categories: { findFirst: vi.fn(async () => state.category) } },
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('filters posts to published only', async () => {
		await load({ params: { slug: 'svelte' } } as never);
		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"posts"."status"');
		expect(params).toContain('published');
	});

	it('groups by year and counts tags, using the stored tag slug for links', async () => {
		state.selectResults = [
			[
				{ id: 'p1', title: 'One', slug: 'one', createdAt: new Date('2024-03-01T00:00:00Z') },
				{ id: 'p2', title: 'Two', slug: 'two', createdAt: new Date('2024-05-01T00:00:00Z') },
				{ id: 'p3', title: 'Three', slug: 'three', createdAt: new Date('2025-01-01T00:00:00Z') }
			],
			[
				{ postId: 'p1', name: 'AI', slug: 'custom-slug' },
				{ postId: 'p2', name: 'AI', slug: 'custom-slug' },
				{ postId: 'p3', name: 'Web', slug: 'web' }
			]
		];
		const data = (await load({ params: { slug: 'svelte' } } as never)) as {
			years: { year: number; count: number }[];
			tags: { name: string; slug: string; count: number }[];
			totalCount: number;
			earliestYear: number;
		};

		expect(data.totalCount).toBe(3);
		expect(data.years.map((y) => [y.year, y.count])).toEqual([
			[2025, 1],
			[2024, 2]
		]);
		// The hand-editable stored slug is the link identity - computing it from
		// the name would produce a dead link (P1.1 review).
		expect(data.tags).toEqual([
			{ name: 'AI', slug: 'custom-slug', count: 2 },
			{ name: 'Web', slug: 'web', count: 1 }
		]);
	});

	it('survives the empty category without touching the tag query', async () => {
		state.selectResults = [[], []];
		const data = (await load({ params: { slug: 'svelte' } } as never)) as {
			years: unknown[];
			tags: unknown[];
			totalCount: number;
		};
		expect(data.totalCount).toBe(0);
		expect(data.years).toEqual([]);
		expect(data.tags).toEqual([]);
	});
});

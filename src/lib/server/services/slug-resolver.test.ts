import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Unit tests for the slug fallback resolver (P3-b grill Q1): a single
 * tracker hop — `slug_trackers` points at the target row id, so chains
 * cannot form (the "≤3 hops" guidance holds by construction). The db module
 * is mocked with a queue of select results; the WHERE/ORDER BY clauses are
 * inspected through drizzle's own dialect so the (type, lang, slug) match
 * and the newest-wins ordering cannot silently change.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[],
		orderArgs: [] as unknown[][]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

import { findSlugTargetId } from './slug-resolver';

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
					if (prop === 'orderBy') state.orderArgs.push(args);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('findSlugTargetId', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.whereArgs = [];
		state.orderArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('matches (type, lang, slug) and returns the newest tracker target', async () => {
		state.selectResults = [[{ targetId: 'post-2' }]];

		const id = await findSlugTargetId('post', 'en', 'old-slug');

		expect(id).toBe('post-2');
		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"slug_trackers"."type"');
		expect(sql).toContain('"slug_trackers"."lang"');
		expect(sql).toContain('"slug_trackers"."slug"');
		expect(params).toEqual(expect.arrayContaining(['post', 'en', 'old-slug']));

		// Deterministic when several rows share a slug: newest tracker wins,
		// with the uuidv7 id as tiebreak (review finding).
		expect(state.orderArgs[0]).toHaveLength(2);
		const primary = dialect.sqlToQuery(state.orderArgs[0]?.[0] as never);
		expect(primary.sql).toContain('"slug_trackers"."created_at"');
		expect(primary.sql.toLowerCase()).toContain('desc');
		const tiebreak = dialect.sqlToQuery(state.orderArgs[0]?.[1] as never);
		expect(tiebreak.sql).toContain('"slug_trackers"."id"');
		expect(tiebreak.sql.toLowerCase()).toContain('desc');
	});

	it('returns null when no tracker row exists', async () => {
		state.selectResults = [[]];
		expect(await findSlugTargetId('post', 'en', 'no-such-slug')).toBeNull();
	});
});

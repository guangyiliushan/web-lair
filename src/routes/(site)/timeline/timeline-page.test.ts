import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the timeline page (P3-b): the stream covers visible
 * posts of the locale (newest first); `?type=note` is the registered empty
 * slot until N1 wires notes in; unknown params (e.g. `memory`) fall back to
 * the full stream. The WHERE clause is inspected through drizzle's own
 * dialect so the locale filter and the visibility predicate have teeth.
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

	it('streams visible posts of the locale, newest first', async () => {
		state.selectResults = [[{ slug: 'p1', title: 'One', publishedAt: new Date(2026, 0, 15, 12) }]];

		const data = (await load(makeEvent())) as {
			type: string;
			items: { kind: string; slug: string; title: string; date: string }[];
		};

		expect(data.type).toBe('all');
		expect(data.items).toEqual([
			{ kind: 'post', slug: 'p1', title: 'One', date: 'January 15, 2026' }
		]);

		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"posts"."lang"');
		expect(sql).toContain('"posts"."status"');
		expect(params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));
	});

	it('renders the empty stream for ?type=note without querying', async () => {
		const data = (await load(makeEvent('note'))) as { type: string; items: unknown[] };

		expect(data.type).toBe('note');
		expect(data.items).toEqual([]);
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('treats unknown params (memory etc.) as the full stream', async () => {
		state.selectResults = [[]];

		const data = (await load(makeEvent('memory'))) as { type: string };

		expect(data.type).toBe('all');
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});
});

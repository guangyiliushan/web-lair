import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the notes list page (N1 + review round 1): the
 * locale + visibility predicates have teeth, locked rows never ship derived
 * content, ordering/limit/offset are observed (not just the WHERE text),
 * the years facet orders by its output alias (the real-PG DISTINCT trap),
 * the unknown-topic filter degrades to an empty list with facets intact,
 * and the pinned card is picked on page one only.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[],
		orderArgs: [] as unknown[][],
		limitArgs: [] as unknown[],
		offsetArgs: [] as unknown[],
		selectDistinctArgs: [] as unknown[][]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'UTC') }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja']
}));

import { NOTE_PAGE_SIZE } from '$lib/utils/note-meta';
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
					if (prop === 'orderBy') state.orderArgs.push(args);
					if (prop === 'limit') state.limitArgs.push(args[0]);
					if (prop === 'offset') state.offsetArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();
const topic = { id: 't1', name: 'Travel', slug: 'travel', icon: 'plane', total: 2 };

function makeEvent(query = '') {
	return { url: new URL(`http://localhost/en/notes${query}`) } as never;
}

const openRow = {
	slug: 'open-one',
	title: 'Open',
	publishedAt: new Date('2026-10-01T10:00:00Z'),
	tz: null,
	content: 'Body **text**.',
	passwordHash: null,
	pinAt: null
};
const gatedRow = {
	slug: 'gated',
	title: 'Gated',
	publishedAt: new Date('2026-10-02T10:00:00Z'),
	tz: null,
	content: 'secret ![x](/i/x.png)',
	passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
	pinAt: null
};
const pinnedRow = {
	slug: 'pinned-one',
	title: 'Pinned',
	publishedAt: new Date('2026-10-03T10:00:00Z'),
	tz: null,
	content: 'Body',
	passwordHash: null,
	pinAt: new Date('2026-10-04T00:00:00Z')
};

describe('notes list page', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.whereArgs = [];
		state.orderArgs = [];
		state.limitArgs = [];
		state.offsetArgs = [];
		state.selectDistinctArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? [])),
			selectDistinct: vi.fn((...args: unknown[]) => {
				state.selectDistinctArgs.push(args);
				return makeChain(state.selectResults.shift() ?? []);
			})
		});
	});

	it('lists visible notes with facets and never leaks locked content', async () => {
		state.selectResults = [[{ total: 2 }], [openRow, gatedRow], [{ year: 2026 }], [topic]];

		const data = (await load(makeEvent())) as {
			total: number;
			notes: unknown[];
			pinnedNote: unknown;
			years: number[];
			topics: unknown[];
		};

		expect(data.total).toBe(2);
		expect(data.notes).toEqual([
			{
				slug: 'open-one',
				title: 'Open',
				locked: false,
				excerpt: 'Body text.',
				image: null,
				date: 'October 1, 2026'
			},
			{
				slug: 'gated',
				title: 'Gated',
				locked: true,
				excerpt: null,
				image: null,
				date: 'October 2, 2026'
			}
		]);
		expect(data.pinnedNote).toBeNull();
		expect(data.years).toEqual([2026]);
		expect(data.topics).toEqual([topic]);

		// Predicate teeth: locale + visibility + bound params on the count query.
		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"notes"."status"');
		expect(sql).toContain('"notes"."lang"');
		expect(params).toEqual(expect.arrayContaining(['en', 'published', 'scheduled']));

		// Ordering teeth: pin DESC NULLS LAST, published DESC, id DESC.
		const order = state.orderArgs[0] as unknown[];
		expect(order).toHaveLength(3);
		expect(dialect.sqlToQuery(order[0] as never).sql).toContain('desc nulls last');
		expect(dialect.sqlToQuery(order[1] as never).sql).toContain('"notes"."published_at" desc');
		expect(dialect.sqlToQuery(order[2] as never).sql).toContain('"notes"."id" desc');
		expect(state.limitArgs).toContain(NOTE_PAGE_SIZE);
		expect(state.offsetArgs).toEqual([0]);
	});

	it('orders the years facet by its output alias (DISTINCT trap tooth)', async () => {
		state.selectResults = [[{ total: 0 }], [], [{ year: 2026 }], []];

		await load(makeEvent());

		const yearsOrder = state.orderArgs[1] as unknown[];
		expect(yearsOrder).toHaveLength(1);
		const yearsSql = dialect.sqlToQuery(yearsOrder[0] as never).sql;
		expect(yearsSql).toBe('"year" desc');
		// The re-rendered parameterized expression would bind $site twice and
		// make PostgreSQL reject the whole query (real-PG review finding).
		expect(yearsSql).not.toContain('coalesce');
		// The alias itself is load-bearing: drizzle only emits ` as "year"`
		// for SQL.Aliased, and without it ORDER BY references a column that
		// does not exist in the select list (real-PG 42703, review round 2).
		const projection = state.selectDistinctArgs[0]?.[0] as { year?: { fieldAlias?: string } };
		expect(projection.year?.fieldAlias).toBe('year');
	});

	it('narrows by topic when it exists', async () => {
		state.selectResults = [[topic], [{ total: 1 }], [openRow], [], [topic]];

		await load(makeEvent('?topic=travel'));

		const { sql } = dialect.sqlToQuery(state.whereArgs[1] as never);
		expect(sql).toContain('"notes"."topic_id"');
	});

	it('degrades an unknown topic filter to an empty list, facets intact', async () => {
		state.selectResults = [[], [{ year: 2026 }], [topic]];

		const data = (await load(makeEvent('?topic=missing'))) as {
			notes: unknown[];
			total: number;
			topics: unknown[];
		};

		expect(data.notes).toEqual([]);
		expect(data.total).toBe(0);
		expect(data.topics).toEqual([topic]);
	});

	it('applies the belongs-to year filter through the tz-aware expression', async () => {
		state.selectResults = [[{ total: 0 }], [], [{ year: 2025 }], []];

		await load(makeEvent('?year=2025'));

		const { sql, params } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain("date_part('year'");
		expect(sql).toContain('at time zone coalesce');
		expect(params).toContain(2025);
	});

	it('picks the pinned card on page one and excludes it from the list', async () => {
		state.selectResults = [[{ total: 2 }], [openRow, pinnedRow], [{ year: 2026 }], [topic]];

		const data = (await load(makeEvent())) as {
			pinnedNote: { slug: string } | null;
			notes: { slug: string }[];
		};

		expect(data.pinnedNote?.slug).toBe('pinned-one');
		expect(data.notes.map((note) => note.slug)).toEqual(['open-one']);
	});

	it('clamps the requested page into the available range', async () => {
		state.selectResults = [[{ total: 4 }], [openRow], [], []];
		const high = (await load(makeEvent('?page=99'))) as { page: number };
		expect(high.page).toBe(1);

		state.selectResults = [[{ total: 4 }], [openRow], [], []];
		const low = (await load(makeEvent('?page=0'))) as { page: number };
		expect(low.page).toBe(1);
	});

	it('never picks a pinned card on later pages', async () => {
		state.selectResults = [[{ total: 13 }], [openRow, pinnedRow], [], []];

		const data = (await load(makeEvent('?page=2'))) as {
			pinnedNote: unknown;
			notes: unknown[];
		};

		expect(data.pinnedNote).toBeNull();
		expect(data.notes).toHaveLength(2);
	});
});

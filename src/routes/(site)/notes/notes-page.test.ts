import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for the notes list page (N1): the locale + visibility
 * predicates have teeth, locked rows never ship derived content, the
 * unknown-topic filter degrades to an empty list with facets intact, and
 * the belongs-to year filter rides through date_part.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], whereArgs: [] as unknown[] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'UTC') }));
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

describe('notes list page', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.whereArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? [])),
			selectDistinct: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
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

		const { sql } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain('"notes"."status"');
		expect(sql).toContain('"notes"."lang"');
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

	it('applies the belongs-to year filter through date_part', async () => {
		state.selectResults = [[{ total: 0 }], [], [{ year: 2025 }], []];

		await load(makeEvent('?year=2025'));

		const { sql } = dialect.sqlToQuery(state.whereArgs[0] as never);
		expect(sql).toContain("date_part('year'");
	});
});

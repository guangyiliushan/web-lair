import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Unit tests for the page read service (P1b): the display fallback chain, the
 * STRICT body resolution + content locales (2026-10-03 ruling), the sitemap
 * predicate and the any-status row fetch. The db module is mocked with a
 * queue of select results.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		whereArgs: [] as unknown[],
		limitArgs: [] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/paraglide/runtime', () => ({ locales: ['en', 'zh-cn', 'ja'] }));

import {
	contentLocales,
	getPageBySlug,
	listSitemapPages,
	resolveLocalized,
	resolvePageContent
} from './pages';

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
					if (prop === 'limit') state.limitArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

const dialect = new PgDialect();

describe('pages read service', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.whereArgs = [];
		state.limitArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('resolves display fields through current → en → any', () => {
		expect(resolveLocalized({ 'zh-cn': '中' }, 'ja')).toBe('中');
		expect(resolveLocalized({ en: 'EN', 'zh-cn': '中' }, 'zh-cn')).toBe('中');
		// en outranks the 'any' tail when the current locale is missing.
		expect(resolveLocalized({ ja: 'JA', en: 'EN' }, 'zh-cn')).toBe('EN');
		expect(resolveLocalized({ en: '  ' }, 'en')).toBeNull();
		expect(resolveLocalized({}, 'en')).toBeNull();
		expect(resolveLocalized(null, 'en')).toBeNull();
	});

	it('serves the body strictly in the current locale (2026-10-03 ruling)', () => {
		expect(resolvePageContent({ ja: '本文', en: 'Body' }, 'ja')).toBe('本文');
		expect(resolvePageContent({ en: 'Body' }, 'ja')).toBeNull();
		expect(resolvePageContent({ ja: '   ' }, 'ja')).toBeNull();
		expect(resolvePageContent(null, 'ja')).toBeNull();
	});

	it('lists content locales in the fixed order for hints and alternates', () => {
		expect(contentLocales({ ja: 'a', en: 'b' })).toEqual(['en', 'ja']);
		expect(contentLocales({ 'zh-cn': 'c' })).toEqual(['zh-cn']);
		expect(contentLocales({})).toEqual([]);
		expect(contentLocales(null)).toEqual([]);
		// Blank values and keys outside the locale list count as missing.
		expect(contentLocales({ en: '   ', 'zh-cn': 'x' })).toEqual(['zh-cn']);
		expect(contentLocales({ en: '  ' })).toEqual([]);
		expect(contentLocales({ fr: 'y', en: 'x' } as Record<string, string>)).toEqual(['en']);
	});

	it('filters the sitemap source: visible ∧ content ∧ internal ∧ non-empty', async () => {
		state.selectResults = [
			[
				{ slug: 'a', content: { en: 'x' }, updatedAt: new Date() },
				{ slug: 'b', content: {}, updatedAt: new Date() }
			]
		];

		const rows = await listSitemapPages();

		expect(rows.map((row) => row.slug)).toEqual(['a']);
		const whereSql = dialect.sqlToQuery(state.whereArgs[0] as never).sql;
		expect(whereSql).toContain('"pages"."status"');
		expect(whereSql).toContain('"pages"."content" is not null');
		expect(whereSql).toContain('"pages"."external_url" is null');
	});

	it('fetches any-status rows by slug with a single-row limit', async () => {
		state.selectResults = [[{ slug: 'about', status: 'hidden' }]];

		const row = await getPageBySlug('about');

		expect(row).toEqual({ slug: 'about', status: 'hidden' });
		expect(state.limitArgs).toEqual([1]);
		const whereSql = dialect.sqlToQuery(state.whereArgs[0] as never).sql;
		expect(whereSql).toContain('"pages"."slug"');
	});
});

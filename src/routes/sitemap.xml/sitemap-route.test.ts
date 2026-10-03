import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Route-level tests for /sitemap.xml (P3-b): home + visible posts per
 * language, per-group alternates, lastmod only from updated_at, stable
 * (lang, slug) ordering, locale whitelisting and the strong-validator cache
 * contract (ETag derived from the body). The db module is mocked with a
 * queue of select results.
 */
const { dbMock, state, envState } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		orderArgs: [] as unknown[][],
		whereArgs: [] as unknown[][]
	},
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => envState);
vi.mock('$lib/paraglide/runtime', () => ({
	locales: ['en', 'zh-cn', 'ja'],
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`
}));

import { GET } from './+server';

const dbDialect = new PgDialect();

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (...args: unknown[]) => {
					if (prop === 'orderBy') state.orderArgs.push(args);
					if (prop === 'where') state.whereArgs.push(args);
					return self;
				};
			}
		}
	);
	return self;
}

function event(headers?: Record<string, string>) {
	return {
		url: new URL('http://localhost/sitemap.xml'),
		request: new Request('http://localhost/sitemap.xml', { headers: headers ?? {} })
	} as never;
}

const groupRows = [
	{
		lang: 'en',
		slug: 'hello',
		updatedAt: new Date('2026-09-30T09:00:00Z'),
		translationGroup: 'g1'
	},
	{
		lang: 'zh-cn',
		slug: 'hello-zh',
		updatedAt: new Date('2026-09-29T09:00:00Z'),
		translationGroup: 'g1'
	},
	{
		lang: 'en',
		slug: 'solo',
		updatedAt: new Date('2026-09-28T09:00:00Z'),
		translationGroup: 'g2'
	}
];

describe('sitemap route', () => {
	beforeEach(() => {
		state.selectResults = [[], [], []];
		state.orderArgs = [];
		state.whereArgs = [];
		envState.env.ORIGIN = 'https://example.com';
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('lists home + visible posts per language with per-group alternates', async () => {
		state.selectResults = [groupRows];

		const response = await GET(event());
		expect(response.status).toBe(200);
		const body = await response.text();

		expect(body).toContain('<loc>https://example.com/</loc>');
		expect(body).toContain('<loc>https://example.com/en/posts/hello</loc>');
		expect(body).toContain('<loc>https://example.com/zh-cn/posts/hello-zh</loc>');
		// Published alternates include both languages of the group (self too).
		expect(body).toContain('hreflang="en" href="https://example.com/en/posts/hello"');
		expect(body).toContain('hreflang="zh-cn" href="https://example.com/zh-cn/posts/hello-zh"');
		// Thin pages stay out.
		expect(body).not.toContain('/posts/tags/');
		expect(body).not.toContain('/posts/categories/');

		expect(response.headers.get('content-type')).toContain('application/xml');
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
		// Newest included updated_at drives Last-Modified.
		expect(response.headers.get('last-modified')).toBe('Wed, 30 Sep 2026 09:00:00 GMT');
		// The strong validator is derived from the exact body bytes.
		const expectedEtag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
		expect(response.headers.get('etag')).toBe(expectedEtag);
	});

	it('falls back to the request origin when ORIGIN is unset (pnpm dev)', async () => {
		delete envState.env.ORIGIN;
		state.selectResults = [[]];

		const response = await GET(event());
		const body = await response.text();
		expect(body).toContain('<loc>http://localhost/</loc>');
	});

	it('skips rows outside the configured locales (review round 2)', async () => {
		state.selectResults = [
			[
				...groupRows,
				{
					lang: 'fr',
					slug: 'bonjour',
					updatedAt: new Date('2026-09-27T09:00:00Z'),
					translationGroup: 'g3'
				}
			]
		];

		const response = await GET(event());
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).not.toContain('bonjour');
	});

	it('orders rows by (lang, slug) so the body — and ETag — stays byte-stable', async () => {
		state.selectResults = [groupRows];
		await GET(event());

		const orderSql = state.orderArgs[0]
			.map((arg) => dbDialect.sqlToQuery(sql`${arg}`).sql)
			.join(' | ');
		expect(orderSql).toContain('"posts"."lang"');
		expect(orderSql).toContain('"posts"."slug"');
		expect(orderSql.indexOf('"posts"."lang"')).toBeLessThan(orderSql.indexOf('"posts"."slug"'));
	});

	it('serves 304 on matching If-None-Match and 200 otherwise (IMS never 304s)', async () => {
		state.selectResults = [groupRows];
		const first = await GET(event());
		const etag = first.headers.get('etag')!;
		const lastModified = first.headers.get('last-modified')!;

		state.selectResults = [groupRows];
		const fresh = await GET(event({ 'if-none-match': etag }));
		expect(fresh.status).toBe(304);
		expect(fresh.headers.get('etag')).toBe(etag);

		state.selectResults = [groupRows];
		const weak = await GET(event({ 'if-none-match': `W/${etag}` }));
		expect(weak.status).toBe(304);

		// IMS alone never 304s: Last-Modified is informational (review round 2).
		state.selectResults = [groupRows];
		const imsAlone = await GET(event({ 'if-modified-since': lastModified }));
		expect(imsAlone.status).toBe(200);

		state.selectResults = [groupRows];
		const changed = await GET(event({ 'if-none-match': '"different"' }));
		expect(changed.status).toBe(200);

		// A different payload changes the derived ETag (content-derived, not static).
		state.selectResults = [[]];
		const empty = await GET(event());
		expect(empty.headers.get('etag')).not.toBe(etag);
	});

	it('keeps an empty sitemap well-formed with the home entry only', async () => {
		state.selectResults = [[]];

		const response = await GET(event());
		const body = await response.text();

		expect(body).toContain('<loc>https://example.com/</loc>');
		expect(body).not.toContain('<lastmod>');
		expect(response.headers.get('last-modified')).toBeNull();
	});

	it('lists feedable notes and topic pages with their alternates (N1 seam)', async () => {
		const noteEn = {
			lang: 'en',
			slug: 'n-en',
			updatedAt: new Date('2026-09-20T09:00:00Z'),
			translationGroup: 'n1'
		};
		state.selectResults = [groupRows, [noteEn], [{ slug: 'travel' }]];

		const body = await (await GET(event())).text();

		// Notes join with their own paths and per-group alternates (self included).
		expect(body).toContain('<loc>https://example.com/en/notes/n-en</loc>');
		expect(body).toContain('hreflang="en" href="https://example.com/en/notes/n-en"');
		// Topic pages: one <loc> per locale with a same-path alternate set
		// (mirrors SeoHead's entity-page default).
		expect(body).toContain('<loc>https://example.com/en/notes/topics/travel</loc>');
		expect(body).toContain('<loc>https://example.com/ja/notes/topics/travel</loc>');
		expect(body).toContain('hreflang="zh-cn" href="https://example.com/zh-cn/notes/topics/travel"');
		// lastmod comes from real updated_at signals only; topics carry none.
		const topicBlock = body
			.split('<url>')
			.find((block) => block.includes('notes/topics/travel') && block.includes('/en/'));
		expect(topicBlock).toBeTruthy();
		expect(topicBlock).not.toContain('<lastmod>');
		// Notes contribute their updated_at to Last-Modified alongside posts.
		expect(body).toContain('<lastmod>2026-09-20T09:00:00.000Z</lastmod>');
	});

	it('gates the notes source on the feedable predicate (visible AND not gated)', async () => {
		await GET(event());

		// Second select = notes (render-level assertion, review lesson).
		const whereSql = state.whereArgs[1]
			.map((arg) => dbDialect.sqlToQuery(arg as never).sql)
			.join(' | ');
		expect(whereSql).toContain('"notes"."status" in');
		expect(whereSql).toContain('"notes"."published_at" <=');
		expect(whereSql).toContain('"notes"."password_hash" is null');
	});
});

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { escapeXml } from '$lib/server/feeds';
import { plainTextExcerpt } from '$lib/utils/excerpt';

/**
 * Route-level tests for /{lang}/rss.xml and the bare /rss.xml alias (P3-b):
 * urn:uuid guids, content:encoded bodies, the temporary 302 alias to the
 * default language, the strong-ETag cache contract (derived from the body,
 * RFC 9110 §13.1 conditional handling) and the empty-feed shape.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		defaultLang: 'en',
		orderArgs: [] as unknown[][],
		limitArgs: [] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: { ORIGIN: 'https://example.com' } }));
vi.mock('$lib/paraglide/runtime', () => ({
	locales: ['en', 'zh-cn', 'ja'],
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => state.defaultLang)
}));
vi.mock('$lib/server/markdown', () => ({
	renderMarkdownToHtml: vi.fn(async (md: string) => `<p>${md}</p>`)
}));

import { GET } from './+server';

const dbDialect = new PgDialect();

const helloRow = {
	id: '019bfc4e-0000-7000-8000-000000000001',
	slug: 'hello',
	title: 'Hello <world>',
	summary: null,
	content: 'Body *text*',
	publishedAt: new Date('2026-09-30T09:00:00Z'),
	updatedAt: new Date('2026-09-30T10:00:00Z')
};

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
					if (prop === 'limit') state.limitArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

function event(pathAndQuery: string, headers?: Record<string, string>) {
	return {
		url: new URL(`http://localhost${pathAndQuery}`),
		request: new Request(`http://localhost${pathAndQuery}`, { headers: headers ?? {} })
	} as never;
}

describe('rss route', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.defaultLang = 'en';
		state.orderArgs = [];
		state.limitArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('serves the per-language feed with urn:uuid guids and content:encoded', async () => {
		state.selectResults = [[helloRow]];

		const response = await GET(event('/en/rss.xml'));
		expect(response.status).toBe(200);
		const body = await response.text();

		expect(body).toContain('<language>en</language>');
		expect(body).toContain('href="https://example.com/en/rss.xml" rel="self"');
		expect(body).toContain(
			'<guid isPermaLink="false">urn:uuid:019bfc4e-0000-7000-8000-000000000001</guid>'
		);
		expect(body).toContain('<link>https://example.com/en/posts/hello</link>');
		expect(body).toContain('<content:encoded><![CDATA[<p>Body *text*</p>]]></content:encoded>');
		expect(body).toContain('<title>Hello &lt;world&gt;</title>');
		expect(body).toContain('<lastBuildDate>Wed, 30 Sep 2026 10:00:00 GMT</lastBuildDate>');
		// A null summary falls back to a plain-text excerpt of the content.
		expect(body).toContain(
			`<description>${escapeXml(plainTextExcerpt('Body *text*'))}</description>`
		);

		expect(response.headers.get('content-type')).toContain('application/rss+xml');
		expect(response.headers.get('last-modified')).toBe('Wed, 30 Sep 2026 10:00:00 GMT');
		// The strong validator is derived from the exact body bytes.
		const expectedEtag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
		expect(response.headers.get('etag')).toBe(expectedEtag);
	});

	it('prefers a trimmed summary for the description when one exists', async () => {
		state.selectResults = [
			[{ ...helloRow, id: '019bfc4e-0000-7000-8000-000000000002', summary: '  Picked summary  ' }]
		];

		const response = await GET(event('/en/rss.xml'));
		const body = await response.text();
		expect(body).toContain('<description>Picked summary</description>');
	});

	it('orders by published_at desc with an id tiebreak and clamps to the item limit', async () => {
		state.selectResults = [[]];
		await GET(event('/en/rss.xml'));

		const orderSql = state.orderArgs[0]
			.map((arg) => dbDialect.sqlToQuery(arg as never).sql)
			.join(' | ');
		expect(orderSql).toContain('"posts"."published_at" desc');
		expect(orderSql).toContain('"posts"."id" desc');
		expect(state.limitArgs).toEqual([20]);
	});

	it('redirects the bare root alias to the default language with a temporary 302', async () => {
		state.defaultLang = 'zh-cn';

		await expect(GET(event('/rss.xml'))).rejects.toMatchObject({
			status: 302,
			location: '/zh-cn/rss.xml'
		});
	});

	it('roundtrips the strong ETag and keeps the empty feed free of lastBuildDate', async () => {
		state.selectResults = [[]];
		const first = await GET(event('/ja/rss.xml'));
		const etag = first.headers.get('etag');
		expect(etag).toBeTruthy();

		state.selectResults = [[]];
		const fresh = await GET(event('/ja/rss.xml', { 'if-none-match': etag! }));
		expect(fresh.status).toBe(304);
		expect(fresh.headers.get('etag')).toBe(etag);

		const body = await first.text();
		expect(body).toContain('<language>ja</language>');
		expect(body).not.toContain('<item>');
		expect(body).not.toContain('<lastBuildDate>');
	});

	it('honours If-None-Match lists/weak validators and IMS when INM is absent', async () => {
		state.selectResults = [[helloRow]];
		const first = await GET(event('/en/rss.xml'));
		const etag = first.headers.get('etag')!;
		const lastModified = first.headers.get('last-modified')!;

		state.selectResults = [[helloRow]];
		const listMatch = await GET(event('/en/rss.xml', { 'if-none-match': `"other", ${etag}` }));
		expect(listMatch.status).toBe(304);

		state.selectResults = [[helloRow]];
		const weakMatch = await GET(event('/en/rss.xml', { 'if-none-match': `W/${etag}` }));
		expect(weakMatch.status).toBe(304);

		state.selectResults = [[helloRow]];
		const imsHit = await GET(event('/en/rss.xml', { 'if-modified-since': lastModified }));
		expect(imsHit.status).toBe(304);

		// INM present and mismatching wins over a covering IMS (RFC 9110 §13.1.3).
		state.selectResults = [[helloRow]];
		const inmWins = await GET(
			event('/en/rss.xml', { 'if-none-match': '"different"', 'if-modified-since': lastModified })
		);
		expect(inmWins.status).toBe(200);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for /{lang}/rss.xml and the bare /rss.xml alias (P3-b):
 * urn:uuid guids, content:encoded bodies, the temporary 302 alias to the
 * default language, the strong-ETag roundtrip and the empty-feed shape.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], defaultLang: 'en' }
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

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

function event(pathAndQuery: string, ifNoneMatch?: string) {
	return {
		url: new URL(`http://localhost${pathAndQuery}`),
		request: new Request(`http://localhost${pathAndQuery}`, {
			headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
		})
	} as never;
}

describe('rss route', () => {
	beforeEach(() => {
		state.selectResults = [[]];
		state.defaultLang = 'en';
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('serves the per-language feed with urn:uuid guids and content:encoded', async () => {
		state.selectResults = [
			[
				{
					id: '019bfc4e-0000-7000-8000-000000000001',
					slug: 'hello',
					title: 'Hello <world>',
					summary: null,
					content: 'Body *text*',
					publishedAt: new Date('2026-09-30T09:00:00Z'),
					updatedAt: new Date('2026-09-30T10:00:00Z')
				}
			]
		];

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

		expect(response.headers.get('content-type')).toContain('application/rss+xml');
		expect(response.headers.get('last-modified')).toBe('Wed, 30 Sep 2026 10:00:00 GMT');
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
		const fresh = await GET(event('/ja/rss.xml', etag!));
		expect(fresh.status).toBe(304);
		expect(fresh.headers.get('etag')).toBe(etag);

		const body = await first.text();
		expect(body).toContain('<language>ja</language>');
		expect(body).not.toContain('<item>');
		expect(body).not.toContain('<lastBuildDate>');
	});
});

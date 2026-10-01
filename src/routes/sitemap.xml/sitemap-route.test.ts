import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for /sitemap.xml (P3-b): home + visible posts per
 * language, per-group alternates, lastmod only from updated_at, and the
 * strong-validator cache contract (ETag roundtrip → 304). The db module is
 * mocked with a queue of select results.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: { ORIGIN: 'https://example.com' } }));
vi.mock('$lib/paraglide/runtime', () => ({
	locales: ['en', 'zh-cn', 'ja'],
	localizeHref: (href: string, options?: { locale?: string }) =>
		`/${options?.locale ?? 'en'}${href}`
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
				return (..._args: unknown[]) => self;
			}
		}
	);
	return self;
}

function event(ifNoneMatch?: string) {
	return {
		request: new Request('http://localhost/sitemap.xml', {
			headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
		})
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
		state.selectResults = [[]];
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
		expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
	});

	it('serves 304 on a matching If-None-Match and 200 on a mismatch', async () => {
		state.selectResults = [groupRows];
		const first = await GET(event());
		const etag = first.headers.get('etag');
		expect(etag).toBeTruthy();

		state.selectResults = [groupRows];
		const fresh = await GET(event(etag!));
		expect(fresh.status).toBe(304);
		expect(fresh.headers.get('etag')).toBe(etag);

		state.selectResults = [groupRows];
		const changed = await GET(event('"different"'));
		expect(changed.status).toBe(200);
	});

	it('keeps an empty sitemap well-formed with the home entry only', async () => {
		state.selectResults = [[]];

		const response = await GET(event());
		const body = await response.text();

		expect(body).toContain('<loc>https://example.com/</loc>');
		expect(body).not.toContain('<lastmod>');
		expect(response.headers.get('last-modified')).toBeNull();
	});
});

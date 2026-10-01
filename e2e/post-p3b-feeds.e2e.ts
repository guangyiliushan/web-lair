import { expect, test } from '@playwright/test';
import { psql } from './support';

/**
 * P3-b distribution-face acceptance (roadmap W2 #4): single-file sitemap with
 * published alternates, per-language RSS with `urn:uuid` guids and
 * content:encoded, the bare `/rss.xml` alias (302 to the default language),
 * dynamic robots.txt and the strong-validator cache contract. Fixtures under
 * `e2e-p3bf%`; cleaned in beforeAll/afterAll.
 */

const CAT_ID = '00000000-0000-7000-8000-00000000c3f0';
const P_ID = '00000000-0000-7000-8000-00000000c3e1';
const P_ID_ZH = '00000000-0000-7000-8000-00000000c3e2';
const GROUP = '00000000-0000-7000-8000-00000000c3e3';
const SLUG = 'e2e-p3bf-post';
const SLUG_ZH = 'e2e-p3bf-post-zh';
const TITLE = 'E2E P3BF feed post';

function cleanup(): void {
	psql(`delete from posts where slug like 'e2e-p3bf-%'`);
	psql(`delete from categories where slug = 'e2e-p3bf-cat'`);
}

test.beforeAll(() => {
	cleanup();
	psql(`insert into categories (id, name, slug) values ('${CAT_ID}', 'E2E P3BF', 'e2e-p3bf-cat')`);
	psql(
		[
			`insert into posts (id, slug, title, content, lang, status, published_at, updated_at, category_id, translation_group) values`,
			`('${P_ID}', '${SLUG}', '${TITLE}', 'Feed body **bold**.', 'en', 'published', '2026-09-18T09:00:00Z', '2026-09-20T09:00:00Z', '${CAT_ID}', '${GROUP}')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, updated_at, category_id, translation_group, translated_from_post_id, translation_origin) values`,
			`('${P_ID_ZH}', '${SLUG_ZH}', 'E2E P3BF 中文', '中文正文。', 'zh-cn', 'published', '2026-09-18T09:00:00Z', '2026-09-20T09:00:00Z', '${CAT_ID}', '${GROUP}', '${P_ID}', 'human')`
		].join(' ')
	);
});

test.afterAll(() => {
	cleanup();
});

test.describe('P3-b distribution face', () => {
	test('the sitemap lists seeded posts with alternates, lastmod and a strong ETag', async ({
		request
	}) => {
		const response = await request.get('/sitemap.xml');
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('application/xml');

		const body = await response.text();
		expect(body).toContain('<loc>http://localhost:4173/</loc>');
		expect(body).toContain(`<loc>http://localhost:4173/en/posts/${SLUG}</loc>`);
		expect(body).toContain(`<loc>http://localhost:4173/zh-cn/posts/${SLUG_ZH}</loc>`);
		expect(body).toContain(`hreflang="zh-cn" href="http://localhost:4173/zh-cn/posts/${SLUG_ZH}"`);
		// Deterministic updated_at from the fixture.
		expect(body).toContain('<lastmod>2026-09-20T09:00:00.000Z</lastmod>');
		// Thin pages stay out.
		expect(body).not.toContain('/posts/tags/');
		expect(body).not.toContain('/posts/categories/');

		const etag = response.headers()['etag'];
		expect(etag).toBeTruthy();
		// Parallel specs insert/delete fixture posts between requests, which
		// legitimately changes the body (and therefore the ETag); re-read the
		// validator instead of treating a 200 as a failure.
		let status = 0;
		let currentEtag = etag!;
		for (let attempt = 0; attempt < 4 && status !== 304; attempt += 1) {
			const fresh = await request.get('/sitemap.xml', {
				headers: { 'if-none-match': currentEtag }
			});
			status = fresh.status();
			currentEtag = fresh.headers()['etag']!;
		}
		expect(status).toBe(304);
	});

	test('the root sitemap serves document requests without redirecting', async ({ page }) => {
		const response = await page.goto('/sitemap.xml');
		expect(response?.status()).toBe(200);
		expect(response?.request().redirectedFrom()).toBeNull();
	});

	test('the language feed carries urn:uuid guids and content:encoded', async ({ request }) => {
		const response = await request.get('/en/rss.xml');
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('application/rss+xml');

		const body = await response.text();
		expect(body).toContain(`<guid isPermaLink="false">urn:uuid:${P_ID}</guid>`);
		expect(body).toContain(`<link>http://localhost:4173/en/posts/${SLUG}</link>`);
		expect(body).toContain('<content:encoded><![CDATA[');
		expect(body).toContain('href="http://localhost:4173/en/rss.xml" rel="self"');
		expect(body).toContain('<language>en</language>');
	});

	test('the bare rss alias redirects to the default-language feed (temporary)', async ({
		request
	}) => {
		// Derive the expected target from the database so the pin follows
		// `site.default_lang` instead of hard-coding the repository baseline.
		const defaultLang =
			(psql(`select value from options where name = 'site.default_lang'`) || '')
				.replace(/["']/g, '')
				.trim() || 'en';

		const response = await request.get('/rss.xml', { maxRedirects: 0 });
		expect(response.status()).toBe(302);
		expect(response.headers()['location']).toBe(`/${defaultLang}/rss.xml`);
	});

	test('robots.txt advertises the sitemap from ORIGIN', async ({ request }) => {
		const response = await request.get('/robots.txt');
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('text/plain');

		const body = await response.text();
		expect(body).toContain('Sitemap: http://localhost:4173/sitemap.xml');
		expect(body).not.toContain('Disallow');
		expect(body).not.toContain('Crawl-delay');
	});

	test('a language without visible posts serves a valid empty feed', async ({ request }) => {
		// Dynamic assertion: count what the database says is visible right now.
		const visible = Number(
			psql(
				`select count(*) from posts where lang = 'ja' and status in ('published','scheduled') and published_at <= now()`
			)
		);

		const response = await request.get('/ja/rss.xml');
		expect(response.status()).toBe(200);

		const body = await response.text();
		expect(body).toContain('<language>ja</language>');
		const items = (body.match(/<item>/g) ?? []).length;
		if (visible === 0) {
			// The repository baseline has no visible ja posts: pin the empty
			// shape explicitly, then keep the parity check for when that changes.
			expect(items).toBe(0);
			expect(body).not.toContain('<item>');
		} else {
			expect(items).toBe(Math.min(visible, 20));
		}
		expect(body.trimEnd().endsWith('</rss>')).toBe(true);
	});
});

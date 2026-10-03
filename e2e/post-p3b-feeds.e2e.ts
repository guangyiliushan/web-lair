import { expect, test } from '@playwright/test';
import { psql } from './support';

/**
 * P3-b distribution-face acceptance (roadmap W2 #4) + the N1 seam: posts and
 * feedable notes share the per-language RSS, the sitemap carries notes and
 * topic pages, and password-gated notes stay out of BOTH (notes plan §3.3
 * exclusion face). Also covers the bare `/rss.xml` alias (302 to the default
 * language), dynamic robots.txt and the strong-validator cache contract.
 * Fixtures under `e2e-p3bf%`; cleaned in beforeAll/afterAll.
 */

const CAT_ID = '00000000-0000-7000-8000-00000000c3f0';
const P_ID = '00000000-0000-7000-8000-00000000c3e1';
const P_ID_ZH = '00000000-0000-7000-8000-00000000c3e2';
const GROUP = '00000000-0000-7000-8000-00000000c3e3';
const SLUG = 'e2e-p3bf-post';
const SLUG_ZH = 'e2e-p3bf-post-zh';
const TITLE = 'E2E P3BF feed post';

// N1 seam fixtures: one feedable note, one password-gated note, one topic.
const N_ID = '00000000-0000-7000-8000-00000000c3e5';
const N_LOCKED_ID = '00000000-0000-7000-8000-00000000c3e6';
const N_SLUG = 'e2e-p3bf-note';
const N_LOCKED_SLUG = 'e2e-p3bf-locked-note';
// Hidden-even-when-once-public rows: status must exclude them on its own
// (published_at is set), per gate item 5 (private / trash invisibility).
const N_PRIVATE_ID = '00000000-0000-7000-8000-00000000c3e8';
const N_PRIVATE_SLUG = 'e2e-p3bf-private-note';
const N_TRASH_ID = '00000000-0000-7000-8000-00000000c3e9';
const N_TRASH_SLUG = 'e2e-p3bf-trash-note';
const T_ID = '00000000-0000-7000-8000-00000000c3e7';
const T_SLUG = 'e2e-p3bf-topic';

function cleanup(): void {
	psql(`delete from notes where slug like 'e2e-p3bf-%'`);
	psql(`delete from topics where slug = '${T_SLUG}'`);
	psql(`delete from posts where slug like 'e2e-p3bf-%'`);
	psql(`delete from categories where slug = 'e2e-p3bf-cat'`);
}

test.beforeAll(() => {
	cleanup();
	psql(`insert into categories (id, name, slug) values ('${CAT_ID}', 'E2E P3BF', 'e2e-p3bf-cat')`);
	psql(
		[
			`insert into notes (id, slug, title, content, lang, status, published_at, updated_at) values`,
			`('${N_ID}', '${N_SLUG}', 'E2E P3BF note', 'Note body **bold**.', 'en', 'published', '2026-09-19T09:00:00Z', '2026-09-21T09:00:00Z')`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, updated_at, password_hash) values`,
			`('${N_LOCKED_ID}', '${N_LOCKED_SLUG}', 'E2E P3BF locked note', 'Secret body.', 'en', 'published', '2026-09-19T10:00:00Z', '2026-09-21T10:00:00Z', 'e2e-locked-hash')`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, updated_at) values`,
			`('${N_PRIVATE_ID}', '${N_PRIVATE_SLUG}', 'E2E P3BF private note', 'Private body.', 'en', 'private', '2026-09-17T09:00:00Z', '2026-09-22T09:00:00Z')`,
			`;`,
			`insert into notes (id, slug, title, content, lang, status, published_at, updated_at) values`,
			`('${N_TRASH_ID}', '${N_TRASH_SLUG}', 'E2E P3BF trash note', 'Trashed body.', 'en', 'trash', '2026-09-16T09:00:00Z', '2026-09-22T09:00:00Z')`,
			`;`,
			`insert into topics (id, name, slug, description) values`,
			`('${T_ID}', 'E2E P3BF topic', '${T_SLUG}', 'Fixture topic for the sitemap seam')`
		].join(' ')
	);
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
		// N1 seam: the feedable note and the topic page are included...
		expect(body).toContain(`<loc>http://localhost:4173/en/notes/${N_SLUG}</loc>`);
		expect(body).toContain(`<loc>http://localhost:4173/en/notes/topics/${T_SLUG}</loc>`);
		expect(body).toContain(
			`hreflang="zh-cn" href="http://localhost:4173/zh-cn/notes/topics/${T_SLUG}"`
		);
		// ...and hidden rows stay out: password gate (§3.3 exclusion face)
		// plus private/trash that had been public before (gate item 5).
		expect(body).not.toContain(N_LOCKED_SLUG);
		expect(body).not.toContain(N_PRIVATE_SLUG);
		expect(body).not.toContain(N_TRASH_SLUG);
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
		// N1 seam: notes share the feed (guid + link), gated notes never do.
		expect(body).toContain(`<guid isPermaLink="false">urn:uuid:${N_ID}</guid>`);
		expect(body).toContain(`<link>http://localhost:4173/en/notes/${N_SLUG}</link>`);
		expect(body).not.toContain(N_LOCKED_ID);
		expect(body).not.toContain(`/notes/${N_LOCKED_SLUG}`);
		expect(body).not.toContain(N_PRIVATE_ID);
		expect(body).not.toContain(N_TRASH_ID);
	});

	test('a mismatching If-None-Match answers 200 with the full body', async ({ request }) => {
		const response = await request.get('/sitemap.xml', {
			headers: { 'if-none-match': '"different"' }
		});
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('<urlset');
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
		// Dynamic assertion: count what the database says is visible right now
		// (N1 seam: the merged feed counts feedable notes alongside posts).
		const visible = Number(
			psql(
				`select (select count(*) from posts where lang = 'ja' and status in ('published','scheduled') and published_at <= now()) + (select count(*) from notes where lang = 'ja' and status in ('published','scheduled') and published_at <= now() and password_hash is null)`
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

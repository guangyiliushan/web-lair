import { expect, test, type Page } from '@playwright/test';
import { psql } from './support';

/**
 * P3-b page family acceptance (roadmap W2 #4): categories / tags / timeline
 * on real data with the locale + visibility filters, the slug fallback 301,
 * the detail SEO head and the in-content canonicalisation path (a relative
 * link inside article markdown still routes through the client sync).
 * Fixtures live under `e2e-p3b%` and are cleaned in beforeAll/afterAll.
 */

const CAT_ID = '00000000-0000-7000-8000-00000000c3b1';
const TAG_ID = '00000000-0000-7000-8000-00000000c3b2';
const P1_ID = '00000000-0000-7000-8000-00000000c3b3';
const P2_ID = '00000000-0000-7000-8000-00000000c3b4';
const P3_ID = '00000000-0000-7000-8000-00000000c3b5';
const G1 = '00000000-0000-7000-8000-00000000c3c1';
const G2 = '00000000-0000-7000-8000-00000000c3c2';

const SLUG1 = 'e2e-p3b-post';
const SLUG1_ZH = 'e2e-p3b-post-zh';
const SLUG2 = 'e2e-p3b-second';
const SLUG_OLD = 'e2e-p3b-old';
const TITLE1 = 'E2E P3B first post';
const TITLE1_ZH = 'E2E P3B 中文文章';
const TITLE2 = 'E2E P3B second post';
const TAG_NAME = 'E2E P3B tag';
const CAT_NAME = 'E2E P3B cat';

function cleanup(): void {
	psql(`delete from slug_trackers where slug like 'e2e-p3b-%'`);
	psql(`delete from post_tags where post_id in (select id from posts where slug like 'e2e-p3b-%')`);
	psql(`delete from posts where slug like 'e2e-p3b-%'`);
	psql(`delete from tags where slug like 'e2e-p3b-%'`);
	psql(`delete from categories where slug like 'e2e-p3b-%'`);
}

test.beforeAll(() => {
	cleanup();
	psql(
		`insert into categories (id, name, slug) values ('${CAT_ID}', '${CAT_NAME}', 'e2e-p3b-cat')`
	);
	psql(`insert into tags (id, name, slug) values ('${TAG_ID}', '${TAG_NAME}', 'e2e-p3b-tag')`);
	psql(
		[
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${P1_ID}', '${SLUG1}', '${TITLE1}', 'Body with a [cross link](/posts/${SLUG2}) inside.', 'en', 'published', now() - interval '1 day', '${CAT_ID}', '${G1}')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group, translated_from_post_id, translation_origin) values`,
			`('${P2_ID}', '${SLUG1_ZH}', '${TITLE1_ZH}', '中文正文。', 'zh-cn', 'published', now() - interval '1 day', '${CAT_ID}', '${G1}', '${P1_ID}', 'human')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${P3_ID}', '${SLUG2}', '${TITLE2}', 'Second body.', 'en', 'published', now() - interval '2 days', '${CAT_ID}', '${G2}')`
		].join(' ')
	);
	psql(
		`insert into post_tags (post_id, tag_id) values ('${P1_ID}', '${TAG_ID}'), ('${P3_ID}', '${TAG_ID}')`
	);
	psql(
		`insert into slug_trackers (type, lang, slug, target_id) values ('post', 'en', '${SLUG_OLD}', '${P1_ID}')`
	);
});

test.afterAll(() => {
	cleanup();
});

function documentLoads(page: Page) {
	let count = 0;
	page.on('load', () => count++);
	return () => count;
}

test.describe('P3-b pages', () => {
	test('the categories index lists the seeded category with its locale count', async ({ page }) => {
		const response = await page.goto('/en/posts/categories');
		expect(response?.status()).toBe(200);

		const link = page.getByRole('link', { name: /E2E P3B cat/ });
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute('href', '/en/posts/categories/e2e-p3b-cat');
		// Two visible en posts in the category (the zh translation is another row).
		await expect(link).toContainText('2');
	});

	test('the category page filters by locale and links posts + tags localized', async ({ page }) => {
		const response = await page.goto('/en/posts/categories/e2e-p3b-cat');
		expect(response?.status()).toBe(200);

		await expect(page.getByRole('heading', { name: CAT_NAME })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE1 })).toHaveAttribute(
			'href',
			`/en/posts/${SLUG1}`
		);
		// Language filter teeth: the zh translation of the same category owns a
		// different slug and must not leak into the en page.
		await expect(page.getByText(TITLE1_ZH)).toHaveCount(0);
		await expect(page.getByRole('link', { name: /^#E2E P3B tag/ })).toHaveAttribute(
			'href',
			'/en/posts/tags/e2e-p3b-tag'
		);
	});

	test('the tags index lists the tag with its count', async ({ page }) => {
		const response = await page.goto('/en/posts/tags');
		expect(response?.status()).toBe(200);

		const link = page.getByRole('link', { name: /^#E2E P3B tag/ });
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute('href', '/en/posts/tags/e2e-p3b-tag');
		await expect(link).toContainText('2');
	});

	test('the tag page lists the locale posts only', async ({ page }) => {
		const response = await page.goto('/en/posts/tags/e2e-p3b-tag');
		expect(response?.status()).toBe(200);

		await expect(page.getByRole('link', { name: TITLE1 })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE2 })).toBeVisible();
		await expect(page.getByText(TITLE1_ZH)).toHaveCount(0);
	});

	test('the timeline streams the posts and the note filter renders', async ({ page }) => {
		const response = await page.goto('/en/timeline');
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('link', { name: TITLE1 })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE2 })).toBeVisible();

		// N1 wires the notes stream in: the note view may be empty or filled,
		// so pin the shell instead of the transient empty state. The dedicated
		// notes e2e spec lands with the N1 public-page batches (batch 4+);
		// until then this view is pinned by shell + route tests only.
		await page.goto('/en/timeline?type=note');
		await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
	});

	test('a retired slug answers 301 to the current one and lands on it', async ({
		page,
		request
	}) => {
		const response = await request.get(`/en/posts/${SLUG_OLD}?utm_source=e2e`, { maxRedirects: 0 });
		expect(response.status()).toBe(301);
		expect(response.headers()['location']).toBe(`/en/posts/${SLUG1}?utm_source=e2e`);

		await page.goto(`/en/posts/${SLUG_OLD}`);
		await expect(page).toHaveURL(`/en/posts/${SLUG1}`);
		await expect(page.getByRole('heading', { name: TITLE1 })).toBeVisible();
	});

	test('nav active state follows the de-localised path (review pin)', async ({ page }) => {
		// `hover:text-primary` also contains the substring — match a standalone
		// token only, or the inactive state would satisfy a naive regex.
		const active = /(^|\s)text-primary(\s|$)/;

		await page.goto(`/en/posts/${SLUG1}`);
		const postsNav = page.getByRole('banner').getByRole('link', { name: 'Posts' }).first();
		await expect(postsNav).toHaveClass(active);

		// zh-cn: labels are localised — locate by href, and pin both directions
		// (Pre-P3-b the header lit nothing here, or lit Home on every page).
		await page.goto(`/zh-cn/posts/${SLUG1_ZH}`);
		const zhNav = page.getByRole('navigation', { name: 'Main navigation' });
		await expect(zhNav.locator('a[href="/zh-cn/posts"]').first()).toHaveClass(active);
		await expect(zhNav.locator('a[href="/"]').first()).not.toHaveClass(active);
	});

	test('a missing post page is noindexed', async ({ page }) => {
		const response = await page.goto('/en/posts/e2e-p3b-does-not-exist');
		expect(response?.status()).toBe(404);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
	});

	test('the detail head carries canonical + hreflang + feed autodiscovery', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG1}`);

		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			'href',
			`http://localhost:4173/en/posts/${SLUG1}`
		);
		// Two visible languages in the translation group.
		await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(2);
		await expect(page.locator('link[hreflang="zh-cn"]')).toHaveAttribute(
			'href',
			`http://localhost:4173/zh-cn/posts/${SLUG1_ZH}`
		);
		await expect(page.locator('link[type="application/rss+xml"]')).toHaveAttribute(
			'href',
			'/en/rss.xml'
		);
	});

	test('an in-content relative link canonicalises via a document navigation', async ({ page }) => {
		// Article markdown links are author-authored and stay unprefixed: the
		// client sync in the root layout must turn the SPA click into one
		// document load on the canonical URL.
		await page.goto(`/en/posts/${SLUG1}`);
		const loads = documentLoads(page);

		const link = page.locator('article a', { hasText: 'cross link' });
		await expect(async () => {
			await link.click();
			await expect(page).toHaveURL(`/en/posts/${SLUG2}`, { timeout: 5000 });
		}).toPass({ timeout: 20000 });

		await expect(page.getByRole('heading', { name: TITLE2 })).toBeVisible();
		await page.waitForTimeout(1500);
		expect(loads()).toBe(1);
	});
});

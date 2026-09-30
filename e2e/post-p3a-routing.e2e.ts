import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

/**
 * P3-a routing nails (roadmap W1 #1, ledger §9.20.2) against the built site:
 *
 *   /              -> 200                (cookie-driven homepage, exempt)
 *   /account       -> 200                (tool page, exempt)
 *   /en/posts/X    -> 200                (canonical content URL)
 *   /posts/X       -> 307 -> /en/posts/X (document requests canonicalise)
 *   /en            -> 404                (bare locale resolves to no route)
 *
 * plus the read-side minimum: list/detail on seeded rows, the missing-
 * language 404 hint, scheduled-in-future invisibility and a language switch
 * on a content page (which must be a single document navigation to the
 * localised URL). Fixtures live on the shared dev database under the
 * `e2e-p3a%` slug prefix and are cleaned in beforeAll/afterAll.
 */

const CATEGORY_ID = '00000000-0000-7000-8000-0000000003a1';
const EN_ID = '00000000-0000-7000-8000-0000000003a2';
const ZH_ID = '00000000-0000-7000-8000-0000000003a3';
const ONLY_EN_ID = '00000000-0000-7000-8000-0000000003a4';
const SCHEDULED_ID = '00000000-0000-7000-8000-0000000003a5';
const GROUP_MAIN = '00000000-0000-7000-8000-0000000003b0';
const GROUP_ONLY_EN = '00000000-0000-7000-8000-0000000003b1';
const GROUP_SCHEDULED = '00000000-0000-7000-8000-0000000003b2';

const SLUG_MAIN = 'e2e-p3a-post';
const SLUG_ONLY_EN = 'e2e-p3a-only-en';
const SLUG_SCHEDULED = 'e2e-p3a-scheduled';
const TITLE_EN = 'E2E P3A English post';
const TITLE_ZH = 'E2E P3A 中文文章';
const TITLE_ONLY_EN = 'E2E P3A only english';
const TITLE_SCHEDULED = 'E2E P3A scheduled future';

function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

function cleanup(): void {
	psql(`delete from posts where slug like 'e2e-p3a%'`);
	psql(`delete from categories where slug = 'e2e-p3a-cat'`);
}

test.beforeAll(() => {
	cleanup();
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY_ID}', 'E2E P3A', 'e2e-p3a-cat')`
	);
	psql(
		[
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${EN_ID}', '${SLUG_MAIN}', '${TITLE_EN}', 'Hello **world** from P3-a.', 'en', 'published', now() - interval '2 days', '${CATEGORY_ID}', '${GROUP_MAIN}')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group, translated_from_post_id, translation_origin) values`,
			`('${ZH_ID}', '${SLUG_MAIN}', '${TITLE_ZH}', '中文正文段落。', 'zh-cn', 'published', now() - interval '1 day', '${CATEGORY_ID}', '${GROUP_MAIN}', '${EN_ID}', 'human')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${ONLY_EN_ID}', '${SLUG_ONLY_EN}', '${TITLE_ONLY_EN}', 'Only available in English.', 'en', 'published', now() - interval '3 days', '${CATEGORY_ID}', '${GROUP_ONLY_EN}')`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${SCHEDULED_ID}', '${SLUG_SCHEDULED}', '${TITLE_SCHEDULED}', 'Not yet published.', 'en', 'scheduled', now() + interval '1 day', '${CATEGORY_ID}', '${GROUP_SCHEDULED}')`
		].join(' ')
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

// The header switcher lives in SSR HTML long before handlers attach; retry
// the pair until the menu is actually open (same guard as lang-switcher).
async function openSwitcher(page: Page, label: string) {
	const trigger = page.getByRole('banner').getByRole('button', { name: label });
	await expect(async () => {
		await trigger.click();
		await expect(page.locator('[role="menuitemradio"]').first()).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
}

test.describe('P3-a routing nails', () => {
	test('the homepage serves 200 (cookie-driven, exempt)', async ({ page }) => {
		const response = await page.goto('/');
		expect(response?.status()).toBe(200);
	});

	test('/account serves 200 (tool page, exempt)', async ({ page }) => {
		const response = await page.goto('/account');
		expect(response?.status()).toBe(200);
	});

	test('the canonical content URL renders the post', async ({ page }) => {
		const response = await page.goto(`/en/posts/${SLUG_MAIN}`);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: TITLE_EN })).toBeVisible();
	});

	test('an unprefixed content URL redirects to the canonical one (307)', async ({ page }) => {
		const seen: Array<{ status: number; location: string | undefined }> = [];
		page.on('response', (response) => {
			if (response.url().includes(`/posts/${SLUG_MAIN}`)) {
				seen.push({ status: response.status(), location: response.headers()['location'] });
			}
		});

		await page.goto(`/posts/${SLUG_MAIN}`);

		await expect(page).toHaveURL(`/en/posts/${SLUG_MAIN}`);
		expect(seen[0]?.status).toBe(307);
		expect(seen[0]?.location).toContain(`/en/posts/${SLUG_MAIN}`);
		await expect(page.getByRole('heading', { name: TITLE_EN })).toBeVisible();
	});

	test('bare locale roots answer 404 without redirecting', async ({ page }) => {
		for (const path of ['/en', '/zh-cn', '/ja']) {
			const response = await page.goto(path);
			expect(response?.status(), `${path} should be a 404`).toBe(404);
			expect(response?.request().redirectedFrom(), `${path} should not redirect`).toBeNull();
		}
	});

	test('non-document requests to an unprefixed URL render, not redirect', async ({ request }) => {
		// The middleware only canonicalises document requests (Sec-Fetch-Dest:
		// document); plain fetches fall through to the de-localised route.
		const response = await request.get(`/posts/${SLUG_MAIN}`);
		expect(response.status()).toBe(200);
	});
});

test.describe('P3-a read side', () => {
	test('the list shows visible posts of the locale and hides scheduled ones', async ({ page }) => {
		const response = await page.goto('/en/posts');
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE_EN })).toBeVisible();
		await expect(page.getByText(TITLE_SCHEDULED)).toHaveCount(0);
	});

	test('the Chinese list shows the Chinese translation', async ({ page }) => {
		await page.goto('/zh-cn/posts');
		await expect(page.getByRole('link', { name: TITLE_ZH })).toBeVisible();
	});

	test('a scheduled-in-future post is not readable yet', async ({ page }) => {
		const response = await page.goto(`/en/posts/${SLUG_SCHEDULED}`);
		expect(response?.status()).toBe(404);
	});

	test('a missing language version answers 404 with an availability hint', async ({ page }) => {
		const response = await page.goto(`/zh-cn/posts/${SLUG_ONLY_EN}`);
		expect(response?.status()).toBe(404);
		await expect(page.getByText('This page is available in:')).toBeVisible();
		const english = page.getByRole('link', { name: 'English' });
		await expect(english).toBeVisible();
		await english.click();
		await expect(page).toHaveURL(`/en/posts/${SLUG_ONLY_EN}`);
		await expect(page.getByRole('heading', { name: TITLE_ONLY_EN })).toBeVisible();
	});

	test('a cookie language canonicalises the unprefixed URL (scenario 24)', async ({ browser }) => {
		const context = await browser.newContext({ storageState: zhCnLocale.storageState });
		const page = await context.newPage();
		const response = await page.goto(`/posts/${SLUG_MAIN}`);
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL(`/zh-cn/posts/${SLUG_MAIN}`);
		await expect(page.getByRole('heading', { name: TITLE_ZH })).toBeVisible();
		await context.close();
	});

	test('the content-page switcher navigates to the localised URL in one load', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG_MAIN}`);
		const loads = documentLoads(page);

		await openSwitcher(page, 'Language');
		await page.locator('[role="menuitemradio"]').filter({ hasText: '简体中文' }).click();

		await expect(page).toHaveURL(`/zh-cn/posts/${SLUG_MAIN}`);
		await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-cn');
		await expect(page.getByRole('heading', { name: TITLE_ZH })).toBeVisible();
		await page.waitForTimeout(1500);
		expect(loads()).toBe(1);
	});
});

import { expect, test, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * P3-a routing nails (roadmap W1 #1, ledger §9.20.2) against the built site:
 *
 *   /              -> 200                (cookie-driven homepage, exempt)
 *   /account       -> 200                (tool page, exempt)
 *   /en/posts/X    -> 200                (canonical content URL)
 *   /posts/X       -> 307 -> /en/posts/X (document requests canonicalise)
 *   /en            -> 404                (bare locale resolves to no route)
 *
 * plus the read-side minimum: list/detail on seeded rows (with language-leak,
 * pinned-card and excerpt teeth), the missing-language 404 hint (filtered to
 * visible languages only), scheduled-in-future invisibility, a language
 * switch on a content page (exactly one document navigation) and the
 * canonical chrome links (the SPA canonicalisation path now lives in the
 * P3-b pages spec, exercised through an in-content relative link).
 * Fixtures live on the shared dev database under the `e2e-p3a%` slug prefix
 * and are cleaned in beforeAll/afterAll.
 */

const CATEGORY_ID = '00000000-0000-7000-8000-0000000003a1';
const EN_ID = '00000000-0000-7000-8000-0000000003a2';
const ZH_ID = '00000000-0000-7000-8000-0000000003a3';
const ONLY_EN_ID = '00000000-0000-7000-8000-0000000003a4';
const SCHEDULED_ID = '00000000-0000-7000-8000-0000000003a5';
const ZH_DRAFT_ID = '00000000-0000-7000-8000-0000000003a6';
const GROUP_MAIN = '00000000-0000-7000-8000-0000000003b0';
const GROUP_ONLY_EN = '00000000-0000-7000-8000-0000000003b1';
const GROUP_SCHEDULED = '00000000-0000-7000-8000-0000000003b2';
const GROUP_ZH_DRAFT = '00000000-0000-7000-8000-0000000003b3';

const SLUG_MAIN = 'e2e-p3a-post';
const SLUG_ONLY_EN = 'e2e-p3a-only-en';
const SLUG_SCHEDULED = 'e2e-p3a-scheduled';
const TITLE_EN = 'E2E P3A English post';
const TITLE_ZH = 'E2E P3A 中文文章';
const TITLE_ONLY_EN = 'E2E P3A only english';
const TITLE_SCHEDULED = 'E2E P3A scheduled future';
const TITLE_ZH_DRAFT = 'E2E P3A 中文草稿';
const BODY_TEXT = 'Hello world from P3-a.';

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
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group, translated_from_post_id, translation_origin, writing_origin, visual_origin, ai_help) values`,
			`('${EN_ID}', '${SLUG_MAIN}', '${TITLE_EN}', 'Hello **world** from P3-a.', 'en', 'published', now() - interval '2 days', '${CATEGORY_ID}', '${GROUP_MAIN}', null, null, 'mostly_ai', 'some', ARRAY['ideas', 'wording'])`,
			`;`,
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group, translated_from_post_id, translation_origin) values`,
			`('${ZH_ID}', '${SLUG_MAIN}', '${TITLE_ZH}', '中文正文段落。', 'zh-cn', 'published', now() - interval '1 day', '${CATEGORY_ID}', '${GROUP_MAIN}', '${EN_ID}', 'human')`,
			`;`,
			// Pinned (pin_at set) so the pinned-card extraction has teeth.
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group, pin_at) values`,
			`('${ONLY_EN_ID}', '${SLUG_ONLY_EN}', '${TITLE_ONLY_EN}', 'Only available in English.', 'en', 'published', now() - interval '3 days', '${CATEGORY_ID}', '${GROUP_ONLY_EN}', now())`,
			`;`,
			// A hidden (draft) translation of the same slug: the availability
			// hint must not list it.
			`insert into posts (id, slug, title, content, lang, status, published_at, category_id, translation_group) values`,
			`('${ZH_DRAFT_ID}', '${SLUG_ONLY_EN}', '${TITLE_ZH_DRAFT}', '草稿。', 'zh-cn', 'draft', now() - interval '1 day', '${CATEGORY_ID}', '${GROUP_ZH_DRAFT}')`,
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
		await expect(page).toHaveURL('/');
		expect(response?.request().redirectedFrom()).toBeNull();
	});

	test('/account serves 200 (tool page, exempt)', async ({ page }) => {
		const response = await page.goto('/account');
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL('/account');
		expect(response?.request().redirectedFrom()).toBeNull();
	});

	test('the canonical content URL renders the post', async ({ page }) => {
		const response = await page.goto(`/en/posts/${SLUG_MAIN}`);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: TITLE_EN })).toBeVisible();
		await expect(page.locator('article').first()).toContainText(BODY_TEXT);
	});

	test('post details use a compact metadata row instead of the provenance panel', async ({
		page
	}) => {
		await page.goto(`/en/posts/${SLUG_MAIN}`);

		await expect(page.locator('article h1')).toHaveClass(/text-center/);
		await expect(page.locator('[data-testid="post-detail-meta"]')).toBeVisible();
		await expect(
			page.locator('[data-testid="post-detail-meta"] [data-testid="post-views"]')
		).toBeVisible();
		await expect(
			page.locator('[data-testid="post-detail-meta"] [data-testid="post-likes"]')
		).toBeVisible();
		await expect(page.locator('[data-testid="post-detail-meta"] .bg-primary')).toHaveCount(0);
		await expect(page.locator('[data-testid="post-provenance"]')).toHaveCount(0);
	});

	test('undisclosed provenance stays out of the metadata row', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG_ONLY_EN}`);
		const meta = page.locator('[data-testid="post-detail-meta"]');
		await expect(meta).toBeVisible();
		await expect(meta).not.toContainText('Visuals not disclosed');
		await expect(meta.locator('[data-testid="post-visuals"]')).toHaveCount(0);
	});

	test('the metadata row stays on one line on desktop', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG_MAIN}`);
		const meta = page.locator('[data-testid="post-detail-meta"]');
		await expect(meta).toBeVisible();

		// Items differ in height (icon buttons vs text), so "same line" means
		// vertical overlap, not identical tops.
		const rows = await meta.evaluate((row) => {
			const rects = Array.from(row.children)
				.filter((child) => child.getBoundingClientRect().width > 0)
				.map((child) => child.getBoundingClientRect())
				.sort((a, b) => a.top - b.top);
			const lines: { top: number; bottom: number }[] = [];
			for (const rect of rects) {
				const last = lines[lines.length - 1];
				if (last && rect.top < last.bottom - 1 && rect.bottom > last.top + 1) {
					last.top = Math.min(last.top, rect.top);
					last.bottom = Math.max(last.bottom, rect.bottom);
				} else {
					lines.push({ top: rect.top, bottom: rect.bottom });
				}
			}
			return lines.length;
		});

		expect(rows).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			await page.evaluate(() => document.documentElement.clientWidth)
		);
	});

	test('mobile stacks the metadata into three rows with the taxonomy last', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 800 });
		await page.goto(`/en/posts/${SLUG_MAIN}`);
		const meta = page.locator('[data-testid="post-detail-meta"]');
		await expect(meta).toBeVisible();

		const layout = await meta.evaluate((row) => {
			const rowRect = row.getBoundingClientRect();
			const groupRect = row
				.querySelector('[data-testid="post-detail-tags"]')!
				.getBoundingClientRect();
			const rects = Array.from(row.children)
				.filter((child) => child.getBoundingClientRect().width > 0)
				.map((child) => child.getBoundingClientRect())
				.sort((a, b) => a.top - b.top);
			const lines: { top: number; bottom: number }[] = [];
			for (const rect of rects) {
				const last = lines[lines.length - 1];
				if (last && rect.top < last.bottom - 1 && rect.bottom > last.top + 1) {
					last.top = Math.min(last.top, rect.top);
					last.bottom = Math.max(last.bottom, rect.bottom);
				} else {
					lines.push({ top: rect.top, bottom: rect.bottom });
				}
			}
			return {
				rows: lines.length,
				taxonomyOwnsLastRow:
					Math.round(groupRect.top) === Math.round(lines[lines.length - 1].top) &&
					groupRect.width >= rowRect.width - 1
			};
		});

		expect(layout.rows).toBe(3);
		expect(layout.taxonomyOwnsLastRow).toBe(true);
	});

	test('the meta row offers the translation group languages and marks its source', async ({
		page
	}) => {
		await page.goto(`/en/posts/${SLUG_MAIN}`);
		const trigger = page.getByTestId('post-translation-trigger');
		await expect(trigger).toContainText('English');

		await trigger.click();
		await expect(page.getByTestId('post-translation-option')).toHaveCount(2);

		const source = page.locator('[data-testid="post-translation-option"][data-lang="en"]');
		await expect(source.locator('[data-testid="post-translation-source"]')).toHaveText('Original');
		await expect(source).toHaveAttribute('data-current', 'true');

		const translated = page.locator('[data-testid="post-translation-option"][data-lang="zh-cn"]');
		await expect(translated).toContainText('简体中文');
		await expect(translated.locator('[data-testid="post-translation-source"]')).toHaveCount(0);
		await expect(translated.locator('a')).toHaveAttribute('href', `/zh-cn/posts/${SLUG_MAIN}`);
	});

	test('the source badge is localised on a translated page', async ({ page }) => {
		await page.goto(`/zh-cn/posts/${SLUG_MAIN}`);
		await page.getByTestId('post-translation-trigger').click();

		const source = page.locator('[data-testid="post-translation-option"][data-lang="en"]');
		await expect(source.locator('[data-testid="post-translation-source"]')).toHaveText('原文');
		await expect(
			page.locator('[data-testid="post-translation-option"][data-lang="zh-cn"]')
		).toHaveAttribute('data-current', 'true');
	});

	test('a single-language post renders no translation switcher', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG_ONLY_EN}`);
		await expect(page.locator('[data-testid="post-detail-meta"]')).toBeVisible();
		await expect(page.getByTestId('post-translation-trigger')).toHaveCount(0);
	});

	test('AI metadata opens a shadcn tooltip card on hover', async ({ page }) => {
		await page.goto(`/en/posts/${SLUG_MAIN}`);

		const trigger = page.getByTestId('post-ai-trigger');
		await expect(trigger).toBeVisible();
		await trigger.hover();
		await expect(page.getByTestId('post-ai-card')).toContainText('Mostly AI');
		await expect(page.getByTestId('post-ai-card')).toContainText('AI-assisted visuals');
		await expect(page.getByTestId('post-ai-card')).toContainText('ideas, wording');
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

	test('a trailing-slash bare locale normalises then 404s', async ({ page }) => {
		const response = await page.goto('/en/');
		expect(response?.status()).toBe(404);
		expect(response?.request().redirectedFrom()).not.toBeNull();
	});

	test('non-document requests to an unprefixed URL render, not redirect', async ({ request }) => {
		// The middleware only canonicalises document requests (Sec-Fetch-Dest:
		// document); plain fetches fall through to the de-localised route.
		// maxRedirects: 0 keeps the assertion honest — if the document guard
		// were dropped this request would turn into a 307.
		const response = await request.get(`/posts/${SLUG_MAIN}`, { maxRedirects: 0 });
		expect(response.status()).toBe(200);
	});
});

test.describe('P3-a read side', () => {
	test('the list shows visible posts of the locale only, with pinned card', async ({ page }) => {
		const response = await page.goto('/en/posts');
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
		await expect(page.getByRole('link', { name: TITLE_EN })).toBeVisible();
		await expect(page.getByText(BODY_TEXT)).toBeVisible();
		await expect(page.getByText('Pinned')).toBeVisible();
		await expect(page.getByText(TITLE_ONLY_EN)).toHaveCount(1);
		await expect(page.getByText(TITLE_ZH)).toHaveCount(0);
		await expect(page.getByText(TITLE_SCHEDULED)).toHaveCount(0);
	});

	test('the Chinese list shows the Chinese translation only', async ({ page }) => {
		await page.goto('/zh-cn/posts');
		await expect(page.getByRole('link', { name: TITLE_ZH })).toBeVisible();
		await expect(page.getByText(TITLE_EN)).toHaveCount(0);
	});

	test('post metadata keeps engagement stats in the same compact row', async ({ page }) => {
		await page.goto('/en/posts');

		const postLink = page.locator(`a[href="/en/posts/${SLUG_MAIN}"]`).last();
		const metadata = postLink.locator('[data-testid="post-meta"]');

		await expect(metadata.locator('[data-testid="post-meta-info"]')).toContainText('E2E P3A');
		await expect(metadata.locator('[data-testid="post-engagement"]')).toBeVisible();
		await expect(
			metadata.locator('[data-testid="post-engagement"] [data-testid="post-views"]')
		).toBeVisible();
		await expect(
			metadata.locator('[data-testid="post-engagement"] [data-testid="post-likes"]')
		).toBeVisible();
		await expect(postLink.locator('[data-testid="post-stats"]')).toHaveCount(0);
	});

	test('a scheduled-in-future post is not readable yet', async ({ page }) => {
		const response = await page.goto(`/en/posts/${SLUG_SCHEDULED}`);
		expect(response?.status()).toBe(404);
	});

	test('a missing language version answers 404 with an availability hint', async ({ page }) => {
		const response = await page.goto(`/zh-cn/posts/${SLUG_ONLY_EN}`);
		expect(response?.status()).toBe(404);
		await expect(page.getByText('此页面提供以下语言版本：')).toBeVisible();
		const english = page.getByRole('link', { name: 'English' });
		await expect(english).toHaveAttribute('href', `/en/posts/${SLUG_ONLY_EN}`);
		await english.click();
		await expect(page).toHaveURL(`/en/posts/${SLUG_ONLY_EN}`);
		await expect(page.getByRole('heading', { name: TITLE_ONLY_EN })).toBeVisible();
	});

	test('the availability hint only lists languages with a visible version', async ({ page }) => {
		// The same slug has an en (visible) and a zh-cn (draft) row; asking
		// for ja must show English only — a dropped visibility filter would
		// leak the draft language into the hint.
		const response = await page.goto(`/ja/posts/${SLUG_ONLY_EN}`);
		expect(response?.status()).toBe(404);
		await expect(page.getByRole('link', { name: 'English' })).toBeVisible();
		await expect(page.getByRole('link', { name: '简体中文' })).toHaveCount(0);
		await expect(page.getByText(TITLE_ZH_DRAFT)).toHaveCount(0);
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
		await page.waitForTimeout(2000);
		expect(loads()).toBe(1);
	});

	test('the chrome Posts link is canonical: SPA navigation without a document load', async ({
		page
	}) => {
		// P3-b unified the chrome links through siteHref: the header link now
		// carries the locale, so clicking it is a plain SPA navigation. The
		// remaining canonicalisation trigger (relative links inside article
		// markdown) is covered by the P3-b pages spec.
		await page.goto(`/en/posts/${SLUG_MAIN}`);
		// Hydration probe (review finding: a fixed sleep raced hydration under
		// load): the language switcher only opens once handlers are live, so a
		// successful open-and-close means the next click is router-intercepted.
		await openSwitcher(page, 'Language');
		await page.keyboard.press('Escape');
		await expect(page.locator('[role="menuitemradio"]')).toHaveCount(0);
		const loads = documentLoads(page);

		const postsLink = page.getByRole('banner').getByRole('link', { name: 'Posts' }).first();
		await expect(postsLink).toHaveAttribute('href', '/en/posts');
		await expect(async () => {
			await postsLink.click();
			await expect(page).toHaveURL('/en/posts', { timeout: 5000 });
		}).toPass({ timeout: 20000 });

		await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
		await page.waitForTimeout(2000);
		expect(loads()).toBe(0);
	});
});

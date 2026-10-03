import { expect, test } from '@playwright/test';
import { psql } from './support';

/**
 * pages-line P1b acceptance (roadmap W3 #6, T5): the default pages render
 * through the universal route (strict per-language bodies + canonical/
 * hreflang), the chrome wires them into the home card / mobile pages group /
 * footer from one SSR query, a missing language answers 404 with the
 * available-language hint, hidden rows stay directly reachable, and the
 * sitemap carries the pages source. Fixtures live under `e2e-p1b%` and are
 * cleaned in beforeAll/afterAll.
 */

const EXTRA_SLUG = 'e2e-p1b-extra';
const HIDDEN_SLUG = 'e2e-p1b-hidden';
const EXTRA_TITLE_EN = 'E2E P1B extra page';
const EXTRA_TITLE_ZH = 'E2E P1B 额外页';
const HIDDEN_TITLE = 'E2E P1B hidden page';

function cleanup(): void {
	psql(`delete from pages where slug like 'e2e-p1b-%'`);
}

test.beforeAll(() => {
	cleanup();
	// Extra visible page: en + zh-cn content only (ja exercises the hint).
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${EXTRA_SLUG}', '{"en":"${EXTRA_TITLE_EN}","zh-cn":"${EXTRA_TITLE_ZH}"}'::jsonb, null, null, null, 'visible', 0, false, '{"en":"# E2E P1B extra body","zh-cn":"# E2E P1B 额外页正文"}'::jsonb, 'markdown')`
	);
	// Hidden page: out of every menu and the sitemap, still directly reachable.
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${HIDDEN_SLUG}', '{"en":"${HIDDEN_TITLE}"}'::jsonb, null, null, null, 'hidden', 51, false, '{"en":"# E2E P1B hidden body"}'::jsonb, 'markdown')`
	);
});

test.afterAll(() => {
	cleanup();
});

test.describe('pages P1b', () => {
	test('the seeded about page renders with canonical + three-locale hreflang', async ({ page }) => {
		const response = await page.goto('/en/about');
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: 'About Me' }).first()).toBeVisible();
		await expect(page).toHaveTitle(/About Me/);
		await expect(page.getByText('This page is ready to edit.')).toBeVisible();

		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			'href',
			'http://localhost:4173/en/about'
		);
		// All three seeded locales carry content — self included in the set.
		await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(3);
		await expect(page.locator('link[hreflang="zh-cn"]')).toHaveAttribute(
			'href',
			'http://localhost:4173/zh-cn/about'
		);
	});

	test('a missing language answers 404 with the available-language hint', async ({ page }) => {
		const response = await page.goto(`/ja/${EXTRA_SLUG}`);
		expect(response?.status()).toBe(404);
		await expect(page.getByText('このページはこの言語ではご利用いただけません')).toBeVisible();
		await expect(page.getByRole('link', { name: 'English', exact: true })).toHaveAttribute(
			'href',
			`/en/${EXTRA_SLUG}`
		);
		await expect(page.getByRole('link', { name: '简体中文', exact: true })).toHaveAttribute(
			'href',
			`/zh-cn/${EXTRA_SLUG}`
		);
	});

	test('a partially translated page advertises only its content languages', async ({ page }) => {
		const response = await page.goto(`/en/${EXTRA_SLUG}`);
		expect(response?.status()).toBe(200);
		await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(2);
		await expect(page.locator('link[hreflang="ja"]')).toHaveCount(0);
	});

	test('hidden pages stay directly reachable (no 404)', async ({ page }) => {
		const response = await page.goto(`/en/${HIDDEN_SLUG}`);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { name: HIDDEN_TITLE })).toBeVisible();
	});

	test('the footer About group renders the two default rows from the chrome query', async ({
		page
	}) => {
		await page.goto('/');
		const footer = page.getByRole('contentinfo');
		await expect(footer.getByRole('link', { name: 'About Me' })).toHaveAttribute(
			'href',
			'/en/about'
		);
		await expect(footer.getByRole('link', { name: 'About This Project' })).toHaveAttribute(
			'href',
			'/en/about-site'
		);
		// Extras never leak into the About group (defaults only).
		await expect(footer.getByRole('link', { name: EXTRA_TITLE_EN })).toHaveCount(0);
	});

	test('the home hover card orders defaults → extras → the four quick links', async ({ page }) => {
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Main navigation' });
		const home = nav.getByRole('link', { name: 'Home' }).first();

		await expect(async () => {
			await home.hover();
			await expect(page.locator('[role="menu"]').first()).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 20000 });

		const panel = page.locator('[role="menu"]').first();
		const items = panel.getByRole('menuitem');
		// The card reads the live registry: other suites' fixtures (or real extra
		// pages) extend the middle, so assert the relative order instead of fixed
		// indices — defaults first, extras after them, quick links trailing.
		const hrefs = await items.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
		expect(hrefs.length).toBeGreaterThanOrEqual(6);
		expect(hrefs.slice(0, 2)).toEqual(['/en/about', '/en/about-site']);
		const extraIndex = hrefs.indexOf(`/en/${EXTRA_SLUG}`);
		expect(extraIndex).toBeGreaterThanOrEqual(2);
		await expect(items.nth(extraIndex)).toHaveText(EXTRA_TITLE_EN);
		const quickStart = hrefs.length - 4;
		expect(hrefs[quickStart]).toBe('/en/rss.xml');
		expect(extraIndex).toBeLessThan(quickStart);
		// Hidden rows never enter the card.
		await expect(panel.getByText(HIDDEN_TITLE)).toHaveCount(0);
	});

	test('the sitemap carries the pages source (per-locale locs + alternates)', async ({
		request
	}) => {
		const body = await (await request.get('/sitemap.xml')).text();
		expect(body).toContain('<loc>http://localhost:4173/en/about</loc>');
		expect(body).toContain('<loc>http://localhost:4173/ja/about</loc>');
		expect(body).toContain('hreflang="zh-cn" href="http://localhost:4173/zh-cn/about"');
		// The extra fixture page carries en + zh-cn content only.
		expect(body).toContain(`<loc>http://localhost:4173/en/${EXTRA_SLUG}</loc>`);
		expect(body).toContain(`<loc>http://localhost:4173/zh-cn/${EXTRA_SLUG}</loc>`);
		expect(body).not.toContain(`<loc>http://localhost:4173/ja/${EXTRA_SLUG}</loc>`);
		expect(body).not.toContain(`hreflang="ja" href="http://localhost:4173/ja/${EXTRA_SLUG}"`);
		// Hidden rows stay out of the sitemap.
		expect(body).not.toContain(HIDDEN_SLUG);
	});

	test.describe('mobile pages group', () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test('the mobile menu folds the same rows into a pages group', async ({ page }) => {
			await page.goto('/');
			const openButton = page.getByRole('button', { name: 'Open menu' });
			const pagesLabel = page.getByText('Pages', { exact: true });

			await expect(async () => {
				if ((await openButton.getAttribute('aria-expanded')) !== 'true') {
					await openButton.click();
				}
				await expect(pagesLabel).toBeVisible({ timeout: 2000 });
			}).toPass({ timeout: 20000 });

			const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
			const row = mobileNav.locator('div.flex.items-center.justify-between', { hasText: 'Pages' });
			await row.getByRole('button').click();
			await expect(mobileNav.getByRole('link', { name: EXTRA_TITLE_EN })).toHaveAttribute(
				'href',
				`/en/${EXTRA_SLUG}`
			);
			await expect(mobileNav.getByRole('link', { name: 'About Me' })).toHaveAttribute(
				'href',
				'/en/about'
			);
			await expect(mobileNav.getByText(HIDDEN_TITLE)).toHaveCount(0);
		});
	});
});

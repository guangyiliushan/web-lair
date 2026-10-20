import { expect, test } from '@playwright/test';
import { openAdminSidebarMenu, pickLocaleMenuItem } from './support';

// A2 acceptance: the admin surface renders from the message catalog. The
// first visit resolves a locale from the browser language (Playwright's
// default en-US lands on the project base locale, en); the sidebar user menu
// switches to zh-cn and back; ja is spot-checked. No DB fixtures - the
// dashboard chrome is enough to observe the message set.

// The retry budgets below (openAdminSidebarMenu 20s + polls) can exceed the
// 30s default test timeout under load; siblings raise it too.
test.describe.configure({ timeout: 120_000 });

test('admin chrome defaults to the en message set', async ({ page }) => {
	await page.goto('/admin');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('en');
	await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
	await expect(page.getByRole('link', { name: '仪表盘' })).toHaveCount(0);
});

test('admin sidebar follows the configured navigation order', async ({ page }) => {
	await page.goto('/admin');

	await expect
		.poll(() =>
			page.locator('[data-sidebar="menu"] a').evaluateAll((links) =>
				links.map((link) => {
					const href = link.getAttribute('href');
					return href ? new URL(href, location.origin).pathname : '';
				})
			)
		)
		.toEqual([
			'/admin',
			'/admin/posts',
			'/admin/notes',
			'/admin/moments',
			'/admin/comments',
			'/admin/pages',
			'/admin/projects',
			'/admin/drafts',
			'/admin/files',
			'/admin/photos',
			'/admin/readers',
			'/admin/friends',
			'/admin/quotes',
			'/admin/thoughts',
			'/admin/analytics',
			'/admin/ai',
			'/admin/settings',
			'/admin/maintenance'
		]);
});

test('sidebar user menu switches to zh-cn and renders Chinese chrome', async ({ page }) => {
	await page.goto('/admin');
	await openAdminSidebarMenu(page);
	await pickLocaleMenuItem(page, '简体中文');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('zh-cn');
	await expect(page.getByRole('link', { name: '仪表盘' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
});

test('switching back to English restores the en message set', async ({ page }) => {
	await page.goto('/admin');
	await openAdminSidebarMenu(page);
	await pickLocaleMenuItem(page, '简体中文');
	await expect(page.getByRole('link', { name: '仪表盘' })).toBeVisible({ timeout: 10000 });

	await openAdminSidebarMenu(page);
	await pickLocaleMenuItem(page, 'English');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('en');
	await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 });
});

test('ja spot check renders Japanese chrome', async ({ page }) => {
	await page.goto('/admin');
	await openAdminSidebarMenu(page);
	await pickLocaleMenuItem(page, '日本語');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('ja');
	await expect(page.getByRole('link', { name: 'ダッシュボード' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
});

import { expect, test, type Page } from '@playwright/test';

// A2 acceptance: the admin surface renders from the message catalog. The
// first visit resolves a locale from the browser language (Playwright's
// default en-US lands on the project base locale, en); the sidebar user menu
// switches to zh-cn and back; ja is spot-checked. No DB fixtures - the
// dashboard chrome is enough to observe the message set.

async function openSidebarMenu(page: Page) {
	// Same locator as lang-switcher.e2e.ts: when the sidebar header button
	// doubles as a DropdownMenu.Trigger its trigger props overwrite the
	// data-slot, so target the header's single button; the pair is retried
	// because the first click can be swallowed before hydration.
	const trigger = page.locator('[data-slot="sidebar-header"]').getByRole('button').first();
	await expect(async () => {
		await trigger.click();
		await expect(page.locator('[role="menuitemradio"]').first()).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
}

async function pickLanguage(page: Page, label: string) {
	await page.locator('[role="menuitemradio"]').filter({ hasText: label }).click();
}

test('admin chrome defaults to the en message set', async ({ page }) => {
	await page.goto('/admin');
	await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
	await expect(page.getByRole('link', { name: '仪表盘' })).toHaveCount(0);
});

test('sidebar user menu switches to zh-cn and renders Chinese chrome', async ({ page }) => {
	await page.goto('/admin');
	await openSidebarMenu(page);
	await pickLanguage(page, '简体中文');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('zh-cn');
	await expect(page.getByRole('link', { name: '仪表盘' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
});

test('switching back to English restores the en message set', async ({ page }) => {
	await page.goto('/admin');
	await openSidebarMenu(page);
	await pickLanguage(page, '简体中文');
	await expect(page.getByRole('link', { name: '仪表盘' })).toBeVisible({ timeout: 10000 });

	await openSidebarMenu(page);
	await pickLanguage(page, 'English');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('en');
	await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 });
});

test('ja spot check renders Japanese chrome', async ({ page }) => {
	await page.goto('/admin');
	await openSidebarMenu(page);
	await pickLanguage(page, '日本語');
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
		.toBe('ja');
	await expect(page.getByRole('link', { name: 'ダッシュボード' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
});

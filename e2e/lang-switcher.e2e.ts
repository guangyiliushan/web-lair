import { test, expect } from '@playwright/test';

test.describe('Language Switcher', () => {
	test('renders language toggle button with ARIA label', async ({ page }) => {
		await page.goto('/');
		// the app pins zh-cn (hooks.client.ts), so the switcher's label is 语言
		await expect(page.getByRole('banner').getByRole('button', { name: '语言' })).toBeVisible({
			timeout: 10000
		});
	});

	test('opens dropdown and displays all available languages', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('banner').getByRole('button', { name: '语言' })).toBeVisible({
			timeout: 10000
		});
		await page.getByRole('banner').getByRole('button', { name: '语言' }).click();
		const menuItems = page.locator('[role="menuitemradio"]');
		await expect(menuItems.first()).toBeVisible({ timeout: 10000 });
		const count = await menuItems.count();
		expect(count).toBeGreaterThanOrEqual(3);
		await expect(menuItems.filter({ hasText: 'English' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '简体中文' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '日本語' })).toBeVisible();
	});

	// The persistence half is real today: localeStore.switchTo writes
	// localStorage('locale') (locale.svelte.ts #persist) and init() re-applies it
	// on boot (+layout.svelte). What is NOT observable is the visible locale
	// change: hooks.client.ts overwrites getLocale to zh-cn until per-user
	// switching ships (admin i18n audit A2+), and no URL-based locale routing
	// exists, so there is no /zh-cn navigation to assert.
	test('selecting a language persists the choice in localStorage', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('banner').getByRole('button', { name: '语言' })).toBeVisible({
			timeout: 10000
		});
		await page.getByRole('banner').getByRole('button', { name: '语言' }).click();
		await page.locator('[role="menuitemradio"]').filter({ hasText: '简体中文' }).click();
		await expect
			.poll(() => page.evaluate(() => window.localStorage.getItem('locale')), { timeout: 5000 })
			.toBe('zh-cn');
		await page.reload();
		const stored = await page.evaluate(() => window.localStorage.getItem('locale'));
		expect(stored).toBe('zh-cn');
	});
});

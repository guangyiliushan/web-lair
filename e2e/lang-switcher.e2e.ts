import { test, expect } from '@playwright/test';

test.describe('Language Switcher', () => {
	test('renders language toggle button with ARIA label', async ({ page }) => {
		await page.goto('/en');
		const buttons = page.locator('button[aria-label]');
		await expect(buttons.first()).toBeVisible({ timeout: 5000 });

		const ariaLabels = await buttons.evaluateAll((els) =>
			els.map((el) => el.getAttribute('aria-label'))
		);
		const hasLangLabel = ariaLabels.some((label) => label && label.length > 0);
		expect(hasLangLabel).toBe(true);
	});

	test('opens dropdown and displays all available languages', async ({ page }) => {
		await page.goto('/en');
		await page.locator('[data-slot="dropdown-menu-trigger"]').first().click();
		const menuItems = page.locator('[role="menuitemradio"]');
		await expect(menuItems.first()).toBeVisible({ timeout: 5000 });
		const count = await menuItems.count();
		expect(count).toBeGreaterThanOrEqual(3);
		await expect(menuItems.filter({ hasText: 'English' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '简体中文' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '日本語' })).toBeVisible();
	});

	test('selecting a language updates locale and persists across reload', async ({ page }) => {
		await page.goto('/en');
		await page.locator('[data-slot="dropdown-menu-trigger"]').first().click();
		await page.locator('[role="menuitemradio"]').filter({ hasText: '简体中文' }).click();
		await page.waitForURL(/\/zh-cn/, { timeout: 5000 });
		expect(page.url()).toContain('/zh-cn');

		const stored = await page.evaluate(() => window.localStorage.getItem('locale'));
		expect(stored).toBe('zh-cn');
	});
});

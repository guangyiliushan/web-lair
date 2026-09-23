import { expect, test, type Page } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

// The preference lives in paraglide's cookie (PARAGLIDE_LOCALE): the server
// renders every page from it and setLocale() writes it and reloads, so a
// switch is observable in <html lang>, the message set and the cookie.
//
// These cases are the regression for the reload loop (2026-09-23): a
// client-side getLocale() pin plus localeStore.init() re-applying a stored
// preference on every load meant a non-pinned preference could never converge
// - each load fired another reload. "Settles" below is measured in document
// loads, so a regression fails the assertion instead of hanging the browser.

function documentLoads(page: Page) {
	let count = 0;
	page.on('load', () => count++);
	return () => count;
}

async function openSwitcher(page: Page, label: string) {
	const trigger = page.getByRole('banner').getByRole('button', { name: label });
	// The trigger is in the SSR HTML long before SvelteKit attaches its
	// handlers, so under load the first click can be swallowed (observed as a
	// clean-full-suite failure on 2026-09-23). Retry the pair; a menu that
	// genuinely never opens still fails, it just costs the 20s budget.
	await expect(async () => {
		await trigger.click();
		await expect(page.locator('[role="menuitemradio"]').first()).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
}

async function pick(page: Page, label: string) {
	await page.locator('[role="menuitemradio"]').filter({ hasText: label }).click();
}

test.describe('Language switcher', () => {
	test.use(zhCnLocale);

	test('renders the language button with its localized label', async ({ page }) => {
		await page.goto('/');
		// pinned zh-cn, so the switcher's label is 语言
		await expect(page.getByRole('banner').getByRole('button', { name: '语言' })).toBeVisible({
			timeout: 10000
		});
	});

	test('opens the dropdown and displays all available languages', async ({ page }) => {
		await page.goto('/');
		await openSwitcher(page, '语言');
		const menuItems = page.locator('[role="menuitemradio"]');
		expect(await menuItems.count()).toBeGreaterThanOrEqual(3);
		await expect(menuItems.filter({ hasText: 'English' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '简体中文' })).toBeVisible();
		await expect(menuItems.filter({ hasText: '日本語' })).toBeVisible();
	});

	// The switch is one reload: the cookie is written, the document reloads so
	// the server renders the new locale, and <html lang> / the message set
	// follow. A second load inside the settle window is the old loop.
	test('switching to English settles after one reload and shows English', async ({ page }) => {
		await page.goto('/');
		const loads = documentLoads(page);

		await openSwitcher(page, '语言');
		await pick(page, 'English');

		await expect
			.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
			.toBe('en');
		await expect(page.getByRole('banner').getByRole('button', { name: 'Language' })).toBeVisible({
			timeout: 10000
		});
		expect(await page.evaluate(() => document.cookie)).toContain('PARAGLIDE_LOCALE=en');
		await expect(page.getByRole('banner').getByRole('link', { name: 'Home' })).toBeVisible();

		await page.waitForTimeout(2000);
		expect(loads()).toBe(1);
	});

	// A plain reload with a saved preference must converge too: this is the
	// exact shape of the old loop (init() re-applied the preference on boot).
	test('a reload keeps the saved locale and does not reload again', async ({ page }) => {
		await page.goto('/');
		await openSwitcher(page, '语言');
		await pick(page, '日本語');
		await expect(page.getByRole('banner').getByRole('button', { name: '言語' })).toBeVisible({
			timeout: 10000
		});

		const loads = documentLoads(page);
		await page.reload();
		await expect(page.getByRole('banner').getByRole('button', { name: '言語' })).toBeVisible({
			timeout: 10000
		});
		await page.waitForTimeout(2000);
		expect(loads()).toBe(1);
	});

	test('switching back to 简体中文 returns to the Chinese message set', async ({ page }) => {
		await page.goto('/');
		await openSwitcher(page, '语言');
		await pick(page, 'English');
		await expect(page.getByRole('banner').getByRole('button', { name: 'Language' })).toBeVisible({
			timeout: 10000
		});

		await openSwitcher(page, 'Language');
		await pick(page, '简体中文');
		await expect
			.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
			.toBe('zh-cn');
		await expect(page.getByRole('banner').getByRole('button', { name: '语言' })).toBeVisible({
			timeout: 10000
		});
	});

	// The public header switcher is not reachable on /admin (the admin shell has
	// its own sidebar), so the sidebar user menu carries the same radio group.
	test('the admin sidebar menu switches locale and settles in one reload', async ({ page }) => {
		await page.goto('/admin');
		// Not [data-slot="sidebar-menu-button"]: when the button doubles as a
		// DropdownMenu.Trigger its trigger props are spread after the data-slot
		// and overwrite it. The sidebar header holds exactly this one button.
		const trigger = page.locator('[data-slot="sidebar-header"]').getByRole('button').first();
		const english = page.locator('[role="menuitemradio"]').filter({ hasText: 'English' });
		await expect(async () => {
			await trigger.click();
			await expect(english).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 20000 });

		const loads = documentLoads(page);
		await english.click();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
			.toBe('en');
		expect(await page.evaluate(() => document.cookie)).toContain('PARAGLIDE_LOCALE=en');
		await page.waitForTimeout(2000);
		expect(loads()).toBe(1);
	});

	// First visit with no cookie: the browser language wins (the docs'
	// "automatic detection with persistent override" pattern). Playwright's
	// `locale` drives both navigator.languages and Accept-Language, so the
	// server and the client resolve the same locale here.
	test.describe('first visit (no cookie)', () => {
		test.use({ storageState: { cookies: [], origins: [] }, locale: 'ja-JP' });

		test('detects the browser language, and a manual switch overrides it', async ({ page }) => {
			await page.goto('/');
			await expect
				.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
				.toBe('ja');
			await expect(page.getByRole('banner').getByRole('button', { name: '言語' })).toBeVisible({
				timeout: 10000
			});

			// the manual choice persists and beats detection on the next load
			await openSwitcher(page, '言語');
			await pick(page, 'English');
			await expect
				.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
				.toBe('en');
			await page.reload();
			await expect
				.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10000 })
				.toBe('en');
			expect(await page.evaluate(() => document.cookie)).toContain('PARAGLIDE_LOCALE=en');
		});
	});
});

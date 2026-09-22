import { test, expect } from '@playwright/test';

// The app pins its locale to zh-cn client-side (hooks.client.ts, "admin i18n
// audit phase A2"), so pages always render the zh-cn message set. Titles live
// in shadcn Card.Title - a div with data-slot="card-title", not an h2.
test.describe('Auth pages', () => {
	test('login page renders', async ({ page }) => {
		await page.goto('/login');
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('欢迎回来');
		await expect(page.locator('input[name="email"]')).toBeVisible();
		await expect(page.locator('input[name="password"]')).toBeVisible();
	});

	test('register page renders', async ({ page }) => {
		await page.goto('/register');
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('创建账户');
		await expect(page.locator('input[name="name"]')).toBeVisible();
		await expect(page.locator('input[name="email"]')).toBeVisible();
		await expect(page.locator('input[name="password"]')).toBeVisible();
		await expect(page.locator('input[name="confirmPassword"]')).toBeVisible();
	});

	test('forgot-password page renders and shows success on submit', async ({ page }) => {
		await page.goto('/forgot-password');
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('重置密码');
		await page.locator('input[name="email"]').fill('test@example.com');
		await page.locator('button[type="submit"]').click();
		// the action always returns success (anti-enumeration); zh-cn copy
		await expect(page.getByRole('status')).toContainText('重置链接');
	});

	test('reset-password redirects without token', async ({ page }) => {
		await page.goto('/reset-password');
		await expect(page).toHaveURL(/\/forgot-password/);
	});

	test('verify-email page renders', async ({ page }) => {
		await page.goto('/verify-email');
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('查收邮件');
	});
});

test.describe('Route protection', () => {
	// localhost counts as a trusted (tailscale) origin, so /admin auto-logs-in
	// in the e2e environment (hooks.server.ts -> tryTailscaleAutoLogin). The
	// unauthenticated branch of requireAdminOwner is unreachable from here and
	// needs unit-level coverage instead.
	test('admin area auto-authenticates the trusted localhost origin', async ({ page }) => {
		await page.goto('/admin');
		await expect(page.getByRole('link', { name: '仪表盘' })).toBeVisible({ timeout: 10000 });
	});

	// The local e2e environment is a trusted (tailscale/localhost) origin, so
	// /admin auto-logs-in. Spoofing a non-trusted client IP exercises the
	// unauthenticated branch of requireAdminOwner (verified live: 303 to the
	// configured admin login with redirectTo). Scoped to this block only.
	test.describe('untrusted origin', () => {
		test.use({ extraHTTPHeaders: { 'x-real-ip': '203.0.113.7' } });

		test('an untrusted origin is redirected to the admin login with redirectTo', async ({
			page
		}) => {
			await page.goto('/admin');
			await expect(page).toHaveURL(/\/admin\/[^/]+\/login\?redirectTo=%2Fadmin/, {
				timeout: 10000
			});
		});
	});

	test('login page is accessible for unauthenticated users', async ({ page }) => {
		await page.goto('/login');
		await expect(page).toHaveURL('/login');
	});

	test('register page is accessible for unauthenticated users', async ({ page }) => {
		await page.goto('/register');
		await expect(page).toHaveURL('/register');
	});
});

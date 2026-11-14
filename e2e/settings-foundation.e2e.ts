import { expect, test } from '@playwright/test';

/**
 * W3 foundation acceptance: the 8-page IA, the two permanent redirects and
 * the deletion of the old system/search routes, plus the structural promise
 * that read-only pages ship zero controls (no input/toggle/dead Save).
 *
 * The loopback origin auto-authenticates as the site owner in the preview
 * (same seam as admin-ai/admin-webhooks), so no login fixture is needed.
 */
test.describe.configure({ timeout: 120_000 });

const PAGES = [
	['profile', 'Profile & Preferences'],
	['site', 'Site'],
	['content', 'Content'],
	['notifications', 'Notifications'],
	['integrations', 'Integrations'],
	['storage', 'Storage'],
	['ai', 'AI'],
	['account', 'Account']
] as const;

test('the settings nav lists exactly the eight final sections', async ({ page }) => {
	await page.goto('/admin/settings');
	const hrefs = await page
		.locator('a[href^="/admin/settings/"]')
		.evaluateAll((links) =>
			links.map((link) => new URL(link.getAttribute('href') ?? '', location.origin).pathname)
		);
	expect(hrefs).toEqual(PAGES.map(([id]) => `/admin/settings/${id}`));
});

test('all eight pages answer 200 with their section heading', async ({ page }) => {
	for (const [id, heading] of PAGES) {
		const response = await page.goto(`/admin/settings/${id}`);
		expect(response?.status(), id).toBe(200);
		await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({
			timeout: 20_000
		});
	}
});

test('planned/read-only pages render zero form controls', async ({ page }) => {
	// Storage left this list in W7: it is now a real owner control plane.
	for (const id of ['site', 'content', 'integrations']) {
		const response = await page.goto(`/admin/settings/${id}`);
		expect(response?.status(), id).toBe(200);
		await expect(
			page.locator('main').locator('input, textarea, select, button').filter({ visible: true })
		).toHaveCount(0);
	}
});

test('the old user/notification routes permanently redirect', async ({ page }) => {
	await page.goto('/admin/settings/user');
	await expect(page).toHaveURL(/\/admin\/settings\/profile$/);
	await page.goto('/admin/settings/notification');
	await expect(page).toHaveURL(/\/admin\/settings\/notifications$/);
});

test('system and search are gone (404)', async ({ page }) => {
	const system = await page.goto('/admin/settings/system');
	expect(system?.status()).toBe(404);
	const search = await page.goto('/admin/settings/search');
	expect(search?.status()).toBe(404);
});

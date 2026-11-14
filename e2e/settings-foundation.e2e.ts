import { expect, test } from '@playwright/test';

/**
 * W3 foundation acceptance plus the W6 content rewrite: the 8-page IA, the two
 * permanent redirects, the deletion of the old system/search routes, and the
 * structural promise that the still-read-only pages ship zero controls (no
 * input/toggle/dead Save). Content is editable since W6, so it is audited for
 * the opposite: every section renders a real form whose buttons submit.
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

test('read-only pages render zero form controls', async ({ page }) => {
	for (const id of ['profile', 'site', 'storage', 'integrations']) {
		const response = await page.goto(`/admin/settings/${id}`);
		expect(response?.status(), id).toBe(200);
		await expect(
			page.locator('main').locator('input, textarea, select, button').filter({ visible: true })
		).toHaveCount(0);
	}
});

test('content renders the real W6 forms and no dead control', async ({ page }) => {
	await page.goto('/admin/settings/content');
	// Seven real forms: comments, comment privacy, friends apply, friends
	// checks, friends policy, reading presence, notes gate.
	const forms = page.locator('main form');
	await expect(forms).toHaveCount(7);
	// Every form has a real submit button (the bits-ui Switch is a button
	// without an explicit type attribute, so assert per form, not globally).
	for (const form of await forms.all()) {
		expect(await form.locator('button[type="submit"]').count()).toBeGreaterThan(0);
	}
	// The removed pseudo controls never come back (case-insensitive: the old
	// labels were sentence-case and the section copy changed in W6).
	await expect(
		page.getByText(
			/anti-spam|blocked ips|blocked words|chinese only|disable comments|approved comments only|ai review|localize avatars/i
		)
	).toHaveCount(0);
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

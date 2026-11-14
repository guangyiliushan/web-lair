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

test('planned/read-only pages render zero form controls', async ({ page }) => {
	// Integrations is the last read-only section (W10.1): a capability map with
	// no action, so it must render zero inputs, selects or buttons.
	for (const id of ['integrations']) {
		const response = await page.goto(`/admin/settings/${id}`);
		expect(response?.status(), id).toBe(200);
		await expect(
			page.locator('main').locator('input, textarea, select, button').filter({ visible: true })
		).toHaveCount(0);
	}
});

test('integrations groups rich, planned and static cards with no token field', async ({ page }) => {
	await page.goto('/admin/settings/integrations');
	for (const heading of ['Rich embeds', 'Planned rich cards', 'Static embeds']) {
		await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
	}
	// The rate-limit facts are the page's whole point: 60/h anonymous, 5,000/h
	// with GITHUB_TOKEN. The token value itself is never rendered.
	await expect(page.getByText(/60\/h/).first()).toBeVisible();
	await expect(page.getByText(/5,000\/h/).first()).toBeVisible();
	await expect(page.locator('input[type="password"], input[name*="token" i]')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
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

test('notifications shows Mail status, Webhooks and the static M6 note', async ({ page }) => {
	const response = await page.goto('/admin/settings/notifications');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Mail', exact: true }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Webhooks', exact: true }).first()).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Human channels (planned)', exact: true }).first()
	).toBeVisible();
	// SMTP credentials are env-only: the page renders status values, never a
	// password input (W9.2 deleted the mock credential fields).
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	// The mock Save is gone. The only mail control is the real test send, and
	// it is disabled while MAIL_ENABLED is not set (e2e runs dev-log mail).
	const send = page.getByRole('button', { name: 'Send test email' }).first();
	await expect(send).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
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

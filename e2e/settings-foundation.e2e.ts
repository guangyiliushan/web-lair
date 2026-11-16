import { expect, test, type Page } from '@playwright/test';
import { apiPost, psql } from './support';

/**
 * W3 foundation acceptance, extended by W10.5: the 8-page IA, the two
 * permanent redirects, the deletion of the old system/search routes, the
 * structural promise that the still-read-only page ships zero controls, a
 * dead-link walk over all eight pages, and the permission split that keeps
 * owner-only sections read-only for a non-owner admin. Content is editable
 * since W6, so it is audited for the opposite: every section renders a real
 * form whose buttons submit.
 *
 * The loopback origin auto-authenticates as the site owner in the preview
 * (same seam as admin-ai/admin-webhooks), so no login fixture is needed -
 * except in the permission test, which signs in as a fixture admin.
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

/** Refuse to mutate anything unless the suite points at the scratch database. */
function assertLocalE2e(): void {
	expect(psql('select current_database()'), 'e2e must run against local_e2e').toBe('local_e2e');
}

/** One home for "this section ships no control", visibility-filtered. */
async function expectNoControls(page: Page): Promise<void> {
	await expect(page.locator('main')).toHaveCount(1);
	await expect(
		page.locator('main').locator('input, textarea, select, button').filter({ visible: true })
	).toHaveCount(0);
}

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
	const response = await page.goto('/admin/settings/integrations');
	expect(response?.status()).toBe(200);
	await expectNoControls(page);
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
	// The static group names the four real providers; the old vague "Music"
	// bucket must not come back.
	for (const provider of ['arXiv', 'LeetCode', 'NetEase', 'QQ']) {
		await expect(page.getByText(provider, { exact: true }).first()).toBeVisible();
	}
	await expect(page.getByText('Music', { exact: true })).toHaveCount(0);
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

test('notifications shows Mail, Webhooks, channel preferences, Bark and the delivery log', async ({
	page
}) => {
	const response = await page.goto('/admin/settings/notifications');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Mail', exact: true }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Webhooks', exact: true }).first()).toBeVisible();
	// M6 P5 replaced the static "Human channels (planned)" note with real
	// surfaces: per-group channel preferences, the Bark status card and the
	// delivery log (owner-only). The old placeholder must not come back.
	await expect(page.getByRole('heading', { name: 'Channels', exact: true }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Bark push', exact: true }).first()).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Notification log', exact: true }).first()
	).toBeVisible();
	await expect(page.getByText(/human channels \(planned\)/i)).toHaveCount(0);
	// Preferences are real controls: three groups × two channels, exactly once
	// each (a duplicated name would post twice and hide a copy/paste bug).
	for (const group of ['comment', 'job', 'ops']) {
		await expect(page.locator(`input[name="${group}_email"]`)).toHaveCount(1);
		await expect(page.locator(`input[name="${group}_bark"]`)).toHaveCount(1);
	}
	// ...and the form is WIRED, not just present: the old spec's page-wide
	// "there is no Save button" guard is gone (the preference form legitimately
	// has one), so the replacement has to prove the button submits the action
	// that persists the switches. A `type="button"` impostor or a form without
	// an action would render identically and would have passed the count-only
	// assertions above.
	const prefsForm = page.locator('form[action="?/saveNotificationPreferences"]').first();
	await expect(prefsForm).toBeVisible();
	await expect(prefsForm.locator('button[type="submit"]')).toHaveCount(1);
	// The delivery log re-queues the SAME row through its own action, so its
	// Resend control must be a submit inside that action (rows only appear once
	// something was delivered; the assertion is conditional for a fresh DB).
	const resendForms = page.locator('form[action="?/resendNotification"]');
	for (const form of await resendForms.all()) {
		await expect(form.locator('input[name="id"]')).toHaveCount(1);
		await expect(form.locator('button[type="submit"]')).toHaveCount(1);
	}
	// SMTP credentials are env-only: the page renders status values, never a
	// password input (W9.2 deleted the mock credential fields).
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	// The mock MAIL save is gone (the only Save on the page is the preference
	// form asserted above). The mail control is the real test send, and it is
	// disabled while MAIL_ENABLED is not set (e2e runs dev-log mail).
	const send = page.getByRole('button', { name: 'Send test email' }).first();
	await expect(send).toBeVisible();
	await expect(send).toBeDisabled();
	// Bark credentials stay env-only in this release (P5-WAITING W2): the block
	// is a status card, so any credential input there would be a lie.
	const bark = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Bark push' }) });
	await expect(bark.locator('input, textarea, select')).toHaveCount(0);
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

test('every internal link on the eight pages resolves (W10.5)', async ({ page, request }) => {
	const targets = new Set<string>();
	for (const [id] of PAGES) {
		const response = await page.goto(`/admin/settings/${id}`);
		expect(response?.status(), id).toBe(200);
		const hrefs = await page
			.locator('body a[href^="/"]')
			.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
		for (const href of hrefs) {
			// Auth callbacks are POST-only; a GET probe would be a false negative.
			if (!href || href.startsWith('/api/auth')) continue;
			targets.add(href.split('#')[0]);
		}
	}
	// Every page contributes at least the shell's links: a silent shrink to
	// zero targets would otherwise pass this test vacuously.
	expect(targets.size).toBeGreaterThanOrEqual(PAGES.length);
	for (const href of targets) {
		const response = await request.get(href);
		expect(response.status(), href).toBeLessThan(400);
	}
});

test('a non-owner admin gets owner sections read-only (W10.5)', async ({ page }) => {
	const email = 'e2e-settings-admin@example.com';
	const password = 'e2e-settings-admin-password-1';

	// Owner precondition: the profile page must be an editable owner control
	// plane before the role split is asserted, otherwise "Read-only" proves
	// nothing about the role.
	await page.goto('/admin/settings/profile');
	await expect(page.getByText('Owner only', { exact: true }).first()).toBeVisible();
	await expect(page.locator('main form').first()).toBeVisible();

	try {
		assertLocalE2e();
		psql(`delete from "user" where email = '${email}'`);
		const signUp = await apiPost(page, '/api/auth/sign-up/email', {
			email,
			name: 'E2E Settings Admin',
			password
		});
		expect([200, 422]).toContain(signUp.status());
		// `returning id` turns a silent UPDATE 0 (wrong database) into a clear
		// failure before the confusing sign-in step.
		expect(
			psql(
				`update "user" set email_verified = true, role = 'admin' where email = '${email}' returning id`
			)
		).not.toBe('');
		const signIn = await apiPost(page, '/api/auth/sign-in/email', { email, password });
		expect(signIn.ok()).toBeTruthy();

		// Profile and Storage are owner control planes: an admin sees the same
		// facts, a read-only badge and no writable control at all.
		for (const id of ['profile', 'storage']) {
			const response = await page.goto(`/admin/settings/${id}`);
			expect(response?.status(), id).toBe(200);
			await expect(page.getByText('Read-only', { exact: true }).first()).toBeVisible();
			await expect(page.locator('main input, main textarea, main select')).toHaveCount(0);
			await expect(
				page.locator('main').getByRole('button', { name: 'Save', exact: true })
			).toHaveCount(0);
		}
		// Integrations is read-only for everyone, including the owner.
		await page.goto('/admin/settings/integrations');
		await expectNoControls(page);
	} finally {
		psql(`delete from "user" where email = '${email}'`);
	}
});

import { expect, test } from '@playwright/test';

/**
 * W5 Site acceptance (goal: W5.2/W5.4/W5.5 arcs): the page is a real editor
 * for the owner (identity form + owner-only language pair), saves round-trip
 * through the database, and the deployment block remains read-only. The
 * scratch `local_e2e` database is mutated by the identity round-trip and then
 * restored, so later specs (friends/micro-c2) still see the original name.
 */
test.describe.configure({ timeout: 120_000 });

test('Site identity saves and reads back; languages are owner-editable', async ({ page }) => {
	await page.goto('/admin/settings/site');
	await expect(page.getByRole('heading', { name: 'Site', exact: true }).first()).toBeVisible();

	const nameInput = page.locator('#site-name');
	await expect(nameInput).toBeVisible();
	const original = await nameInput.inputValue();
	const probe = `${original} E2E`.slice(0, 80);

	const identity = page.locator('form').filter({ has: page.locator('#site-name') });
	try {
		await nameInput.fill(probe);
		await identity.getByRole('button', { name: 'Save' }).click();
		await expect(identity.getByRole('status')).toContainText(/saved/i);

		await page.reload();
		await expect(page.locator('#site-name')).toHaveValue(probe);
	} finally {
		const current = page.locator('#site-name');
		if (await current.count()) {
			await current.fill(original);
			await page
				.locator('form')
				.filter({ has: page.locator('#site-name') })
				.getByRole('button', { name: 'Save' })
				.click();
			await expect(
				page
					.locator('form')
					.filter({ has: page.locator('#site-name') })
					.getByRole('status')
			).toContainText(/saved/i);
		}
	}

	// Owner-only language pair: the form is present (three checkboxes + default
	// select) and the deployment block has no TLS/certificate control.
	await expect(page.locator('input[name="enabled"]')).toHaveCount(3);
	await expect(page.locator('#site-default-lang')).toBeVisible();
	await expect(
		page.locator('input[name="tls"], input[name="certificate"], input[name="acme"]')
	).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

/**
 * W5 Site acceptance (goal: W5.2/W5.4/W5.5 arcs): the page is a real editor
 * for the owner (identity + favicon + owner-only language pair), saves
 * round-trip through the database, and the deployment block remains read-only.
 * The scratch `local_e2e` database is mutated by the round-trips and restored
 * (name + icon URL), so later specs still see the original identity.
 */
test.describe.configure({ timeout: 120_000 });

test('Site identity/favicon save and read back; owner controls render', async ({ page }) => {
	await page.goto('/admin/settings/site');
	await expect(page.getByRole('heading', { name: 'Site', exact: true }).first()).toBeVisible();

	const identity = page.locator('form').filter({ has: page.locator('#site-name') });
	const nameInput = page.locator('#site-name');
	await expect(nameInput).toBeVisible();
	const original = await nameInput.inputValue();
	const probe = `${original} E2E`.slice(0, 80);

	try {
		await nameInput.fill(probe);
		await identity.getByRole('button', { name: 'Save' }).click();
		await expect(identity.getByRole('status')).toContainText(/saved/i);
		// A clean form proves the action finished (the reload guard is disarmed).
		await expect(identity.getByRole('button', { name: 'Save' })).toBeDisabled();

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

	// Favicon: the /i/ proxy needs no network probe, so the version row and the
	// root-layout `?v=` link can be asserted deterministically.
	const iconForm = page.locator('form').filter({ has: page.locator('#site-icon') });
	const versionRow = page.getByTestId('site-icon-version');
	const before = Number(await versionRow.textContent());
	try {
		await page.locator('#site-icon').fill('/i/e2e-favicon.svg');
		await iconForm.getByRole('button', { name: 'Save' }).click();
		await expect(iconForm.getByRole('status')).toContainText(/saved/i);
		await expect(versionRow).toHaveText(String(before + 1));
		await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
			'href',
			/\/i\/e2e-favicon\.svg\?v=\d+/
		);
	} finally {
		// Reload first: the successful save resets the local dirty state via an
		// effect, so clearing the field immediately afterwards can race that
		// reset (the Save button stays disabled and the edit is lost).
		await page.reload();
		const iconInput = page.locator('#site-icon');
		if (await iconInput.count()) {
			await iconInput.fill('');
			const restoreSave = page
				.locator('form')
				.filter({ has: page.locator('#site-icon') })
				.getByRole('button', { name: 'Save' });
			await expect(restoreSave).toBeEnabled();
			await restoreSave.click();
			await expect(
				page
					.locator('form')
					.filter({ has: page.locator('#site-icon') })
					.getByRole('status')
			).toContainText(/saved/i);
		}
	}

	// Root head: manifest + og:site_name reach the home page (W5.3).
	await page.goto('/');
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
		'href',
		'/manifest.webmanifest'
	);
	await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', /.+/);
	await expect(page.locator('link[rel="icon"]')).toHaveCount(1);

	// Owner-only language pair renders its real controls; no TLS input exists.
	await page.goto('/admin/settings/site');
	await expect(page.locator('input[name="enabled"]')).toHaveCount(3);
	await expect(page.locator('#site-default-lang')).toBeVisible();
	await expect(
		page.locator('input[name="tls"], input[name="certificate"], input[name="acme"]')
	).toHaveCount(0);
});

test('Search indexing is read-only, real routes only (W10.2)', async ({ page, request }) => {
	const response = await page.goto('/admin/settings/site');
	expect(response?.status()).toBe(200);

	const section = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Search indexing', exact: true }) });
	await expect(section).toBeVisible();
	await expect(section.getByText('/sitemap.xml', { exact: true })).toBeVisible();
	await expect(section.getByText('/robots.txt', { exact: true })).toBeVisible();
	// Site search is called out as unimplemented, not offered as a setting.
	await expect(section.getByText('Site search', { exact: true })).toBeVisible();
	await expect(section.getByText('Not implemented', { exact: true })).toBeVisible();
	await expect(section.getByText(/separate project/i)).toBeVisible();
	// No key/token field and no Save in the SEO section.
	await expect(section.locator('input, textarea, select, button, form')).toHaveCount(0);

	// The two advertised endpoints are the real ones.
	const sitemap = await request.get('/sitemap.xml');
	expect(sitemap.status()).toBe(200);
	expect(await sitemap.text()).toContain('urlset');
	const robots = await request.get('/robots.txt');
	expect(robots.status()).toBe(200);
	expect(await robots.text()).toContain('Sitemap:');
});

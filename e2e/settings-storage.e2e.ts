import { expect, test } from '@playwright/test';
import { expectNoCriticalAxe, psql } from './support';

/**
 * Acceptance arc for the Storage control plane, against the isolated
 * `local_e2e` database only (it writes `options` rows). The spec proves the
 * four behaviours the batch promises and a route test cannot fully show:
 *
 *   1. six real sections exist and the page is an owner control plane;
 *   2. Save writes the CANDIDATE — the live provider section does not change;
 *   3. Test runs a REAL probe (HeadBucket + capabilities + Put/Get/Delete)
 *      against the bundled RustFS and reports it;
 *   4. the purge TTL form enforces the 1-day floor and saving deletes nothing.
 *
 * Credentials are never asserted by value; the page must show hints only.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

function assertLocalE2e(): void {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('W7 e2e requires DATABASE_URL pointing at local_e2e');
	const name = new URL(url).pathname.replace(/^\//, '');
	if (name !== 'local_e2e') {
		throw new Error(`W7 e2e refuses to write ${name}; use DATABASE_URL=...local_e2e`);
	}
}

function resetStorageOptions(): void {
	psql(
		`delete from options where name in ('storage.provider', 'storage.active', 'storage.status', 'storage.migration', 'media.purge')`
	);
}

test.beforeAll(() => {
	assertLocalE2e();
	resetStorageOptions();
});

test.afterAll(() => {
	resetStorageOptions();
});

test('renders the six storage sections with a real owner form', async ({ page }) => {
	const response = await page.goto('/admin/settings/storage');
	expect(response?.status()).toBe(200);

	for (const heading of [
		'Current storage',
		'Provider',
		'Credentials',
		'Migration & cutover',
		'Media purge',
		'Read-only'
	]) {
		await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
	}

	// The owner control plane is really writable: a provider form, a test
	// button and a purge form exist (the placeholder had none).
	await expect(page.locator('form[action="?/saveProvider"]')).toBeVisible();
	await expect(page.locator('form[action="?/testProvider"]')).toBeVisible();
	await expect(page.locator('form[action="?/savePurge"]')).toBeVisible();
	// Credentials are write-only: password inputs, no readable value fields.
	await expect(page.locator('input#accessKeyId[type="password"]')).toBeVisible();

	await expectNoCriticalAxe(page, 'storage settings (owner)');
});

test('the connection test probes the bundled RustFS for real', async ({ page }) => {
	await page.goto('/admin/settings/storage');

	await page.locator('form[action="?/testProvider"] button[type="submit"]').click();

	// Success is a real roundtrip (HeadBucket + Put/Get/Delete under probe/).
	await expect(page.getByText(/Connection OK/i).first()).toBeVisible({ timeout: 30_000 });
	const status = psql(`select value::text from options where name = 'storage.status'`);
	expect(status).toContain('"lastTestOk": true');
	expect(status).toContain('"lastStatus": "ok"');
	// The probe covered versioning/object lock, which the page renders.
	expect(status).toContain('"bucketVersioning": "off"');
});

test('saving an external candidate never switches the live provider', async ({ page }) => {
	await page.goto('/admin/settings/storage');

	// Switch the form to external S3 with a syntactically valid endpoint. An
	// IP literal keeps the save path off DNS (the SSRF guard classifies it
	// directly); nothing is dialled and nothing is activated.
	await page.getByRole('radio', { name: /External S3/i }).check();
	await page.locator('select#providerType').selectOption('custom');
	await page.locator('input#endpoint').fill('https://93.184.216.34');
	await page.locator('input#bucket').fill('lair-media');
	await page.locator('select#deleteMode').selectOption('hard');

	const save = page.locator('form[action="?/saveProvider"] button[type="submit"]');
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByText(/Saved as inactive/i).first()).toBeVisible({ timeout: 20_000 });

	// Candidate stored...
	expect(psql(`select value::text from options where name = 'storage.provider'`)).toContain(
		'"driver": "s3"'
	);
	// ...and the live row is untouched: no row at all (the local default still
	// applies) or a row that still says `local`.
	const active = psql(`select value::text from options where name = 'storage.active'`);
	expect(active === '' || active.includes('"driver": "local"')).toBe(true);
	// The read-only "Current storage" section still reports the local driver.
	const currentSection = page.locator('section').filter({ hasText: 'Current storage' }).first();
	await expect(currentSection.getByText('local', { exact: true }).first()).toBeVisible();
});

test('the purge form enforces the 1-day floor and saving deletes nothing', async ({ page }) => {
	await page.goto('/admin/settings/storage');

	// The floor has two layers on purpose: the number input refuses < 1 in the
	// browser (so a stray 0 never leaves the page) and the action re-checks it
	// server-side (unit-tested). Assert the UI layer, and that nothing was
	// written.
	const pending = page.locator('input#pendingDays');
	await pending.fill('0');
	expect(await pending.evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(
		false
	);
	await page.locator('form[action="?/savePurge"] button[type="submit"]').click();
	expect(psql(`select value::text from options where name = 'media.purge'`)).toBe('');

	// A valid pair saves, and the message says the TTL change deletes nothing.
	// (Not 7/30: that is the current value, so the form would be clean.)
	await pending.fill('5');
	await page.locator('input#detachedDays').fill('45');
	const save = page.locator('form[action="?/savePurge"] button[type="submit"]');
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByText(/Nothing was deleted/i).first()).toBeVisible({ timeout: 20_000 });
	expect(psql(`select value::text from options where name = 'media.purge'`)).toContain(
		'"pendingDays": 5'
	);
});

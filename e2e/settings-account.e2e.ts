import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { apiPost, psql } from './support';

/**
 * W8 account acceptance: real load, multi-session devices, password change,
 * passkey management and read-only OAuth. The owner is auto-signed-in by the
 * loopback Tailnet seam; the password fixture is a separate admin-capable
 * account so the owner's credential is never changed by the suite.
 */
test.describe.configure({ timeout: 120_000 });

const FIXTURE_EMAIL = 'e2e-account@example.com';
const FIXTURE_PASSWORD = 'e2e-account-password-1';
const FIXTURE_NEW_PASSWORD = 'e2e-account-password-2';
const PASSKEY_ONLY_EMAIL = 'e2e-passkey-only@example.com';
const PASSKEY_ONLY_PASSWORD = 'e2e-passkey-only-password-1';

async function sessionJson(context: BrowserContext): Promise<unknown> {
	const response = await context.request.get('/api/auth/get-session');
	expect(response.ok()).toBeTruthy();
	return response.json();
}

async function gotoAccount(page: Page) {
	const response = await page.goto('/admin/settings/account');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Account', exact: true }).first()).toBeVisible({
		timeout: 20_000
	});
}

test.describe('real load / static truth', () => {
	test('the page carries no mock controls or old copy', async ({ page }) => {
		await gotoAccount(page);

		await expect(page.getByText('API Token', { exact: true })).toHaveCount(0);
		await expect(page.getByText(/192\.168\.1\.100|10\.0\.0\.52|MacBook Pro/)).toHaveCount(0);
		await expect(page.getByText(/Rotating your password/i)).toHaveCount(0);
		await expect(page.getByText('/api/v3/')).toHaveCount(0);
		await expect(
			page.locator('input[name="clientId"], input[name="clientSecret"], input[name="apiToken"]')
		).toHaveCount(0);

		// OAuth is read-only status + exact callbacks.
		await expect(page.getByText('http://localhost:4173/api/auth/callback/github')).toBeVisible();
		await expect(page.getByText('http://localhost:4173/api/auth/callback/google')).toBeVisible();
		await expect(page.getByText('GitHub', { exact: true })).toBeVisible();
		await expect(page.getByText('Google (planned)', { exact: true })).toBeVisible();

		// 2FA is scoped to password sign-in; passkeys are a documented bypass.
		await expect(page.getByText(/TOTP applies only to password sign-in/i).first()).toBeVisible();
		await expect(page.getByText(/not challenged by TOTP/i).first()).toBeVisible();
	});

	test('the page HTML contains no credential or session token', async ({ page }) => {
		const response = await page.goto('/admin/settings/account');
		const html = await response!.text();
		expect(html).not.toContain('better-auth.session_token');
		expect(html).not.toContain('GITHUB_CLIENT_SECRET=');
		expect(html).not.toContain('"accessToken"');
	});
});

test.describe('multi-session devices', () => {
	const DEVICE_EMAIL = 'e2e-devices@example.com';
	const DEVICE_PASSWORD = 'e2e-devices-password-1';

	test.beforeAll(() => {
		psql(`delete from "user" where email = '${DEVICE_EMAIL}'`);
	});
	test.afterAll(() => {
		psql(`delete from "user" where email = '${DEVICE_EMAIL}'`);
	});

	async function signInFixture(page: Page) {
		const signUp = await apiPost(page, '/api/auth/sign-up/email', {
			email: DEVICE_EMAIL,
			name: 'E2E Devices',
			password: DEVICE_PASSWORD
		});
		expect([200, 422]).toContain(signUp.status());
		psql(`update "user" set email_verified = true, role = 'admin' where email = '${DEVICE_EMAIL}'`);
		const signIn = await apiPost(page, '/api/auth/sign-in/email', {
			email: DEVICE_EMAIL,
			password: DEVICE_PASSWORD
		});
		expect(signIn.ok()).toBeTruthy();
	}

	test('revoke one device, revoke others and sign out', async ({ browser, page }) => {
		test.setTimeout(180_000);
		await signInFixture(page);

		const other: BrowserContext = await browser.newContext();
		const otherPage = await other.newPage();
		try {
			await signInFixture(otherPage);
			await gotoAccount(page);
			await gotoAccount(otherPage);

			const devices = page.locator('section').filter({
				has: page.getByRole('heading', { name: 'Signed-in devices', exact: true })
			});
			await expect(devices.getByText('Current', { exact: true })).toHaveCount(1);
			const rows = devices.locator('ul > li');
			await expect(rows).toHaveCount(2);

			page.once('dialog', (dialog) => dialog.accept());
			await devices.getByRole('button', { name: 'Revoke', exact: true }).click();
			await expect(rows).toHaveCount(1, { timeout: 20_000 });
			expect(await sessionJson(other)).toBeNull();
			expect(await sessionJson(page.context())).not.toBeNull();

			// A third context adds a second device again; revoke others keeps
			// only the current one.
			const third: BrowserContext = await browser.newContext();
			const thirdPage = await third.newPage();
			try {
				await signInFixture(thirdPage);
				await gotoAccount(thirdPage);
				await page.reload();
				await expect(rows).toHaveCount(2);
				page.once('dialog', (dialog) => dialog.accept());
				await devices.getByRole('button', { name: 'Sign out other devices' }).click();
				await expect(rows).toHaveCount(1, { timeout: 20_000 });
				expect(await sessionJson(third)).toBeNull();
				expect(await sessionJson(page.context())).not.toBeNull();
			} finally {
				await third.close();
			}

			// Sign out ends the current session and lands on the admin sign-in.
			page.once('dialog', (dialog) => dialog.accept());
			await devices.getByRole('button', { name: 'Sign out', exact: true }).click();
			await page.waitForURL(/\/admin\/[^/]+\/login/, { timeout: 20_000 });
			expect(await sessionJson(page.context())).toBeNull();
		} finally {
			await other.close();
		}
	});
});

test.describe('password change', () => {
	test.beforeAll(() => {
		psql(`delete from "user" where email = '${FIXTURE_EMAIL}'`);
	});
	test.afterAll(() => {
		psql(`delete from "user" where email = '${FIXTURE_EMAIL}'`);
	});

	test('rejects a wrong current password, then revokes other sessions', async ({
		browser,
		page
	}) => {
		test.setTimeout(180_000);
		const signUp = await apiPost(page, '/api/auth/sign-up/email', {
			email: FIXTURE_EMAIL,
			name: 'E2E Account',
			password: FIXTURE_PASSWORD
		});
		expect([200, 422]).toContain(signUp.status());
		psql(
			`update "user" set email_verified = true, role = 'admin' where email = '${FIXTURE_EMAIL}'`
		);
		const signIn = await apiPost(page, '/api/auth/sign-in/email', {
			email: FIXTURE_EMAIL,
			password: FIXTURE_PASSWORD
		});
		expect(signIn.ok()).toBeTruthy();

		// Second session for the same fixture account.
		const other: BrowserContext = await browser.newContext();
		const otherPage = await other.newPage();
		try {
			const otherSignIn = await apiPost(otherPage, '/api/auth/sign-in/email', {
				email: FIXTURE_EMAIL,
				password: FIXTURE_PASSWORD
			});
			expect(otherSignIn.ok()).toBeTruthy();

			await page.goto('/admin/settings/account');
			await expect(page.getByRole('heading', { name: 'Change password' }).first()).toBeVisible();

			await page.locator('input[name="currentPassword"]').fill('wrong-password');
			await page.locator('input[name="newPassword"]').fill(FIXTURE_NEW_PASSWORD);
			await page.locator('input[name="confirmPassword"]').fill(FIXTURE_NEW_PASSWORD);
			await page.getByRole('button', { name: 'Change password' }).click();
			await expect(page.getByRole('alert')).toContainText(/current password is incorrect/i, {
				timeout: 20_000
			});

			await page.locator('input[name="currentPassword"]').fill(FIXTURE_PASSWORD);
			await page.locator('input[name="newPassword"]').fill(FIXTURE_NEW_PASSWORD);
			await page.locator('input[name="confirmPassword"]').fill(FIXTURE_NEW_PASSWORD);
			await page.getByRole('button', { name: 'Change password' }).click();
			await expect(page.getByText('Password changed. Other devices were signed out.')).toBeVisible({
				timeout: 30_000
			});

			expect(await sessionJson(other)).toBeNull();
			expect(await sessionJson(page.context())).not.toBeNull();
			expect(
				psql(
					`select count(*) from "session" s join "user" u on u.id = s.user_id where u.email = '${FIXTURE_EMAIL}'`
				)
			).toBe('1');

			// The new password works and the old one no longer does.
			const oldSignIn = await apiPost(page, '/api/auth/sign-in/email', {
				email: FIXTURE_EMAIL,
				password: FIXTURE_PASSWORD
			});
			expect(oldSignIn.ok()).toBeFalsy();
			const newSignIn = await apiPost(page, '/api/auth/sign-in/email', {
				email: FIXTURE_EMAIL,
				password: FIXTURE_NEW_PASSWORD
			});
			expect(newSignIn.ok()).toBeTruthy();

			expect(
				psql(
					`select a.event from activities a join "user" u on u.id = a.actor_id where u.email = '${FIXTURE_EMAIL}' order by a.created_at desc limit 1`
				)
			).toBe('account.password_change');
		} finally {
			await other.close();
		}
	});
});

test.describe('passkey management', () => {
	test('adds, renames and deletes a virtual passkey', async ({ page, context }) => {
		test.setTimeout(180_000);
		const name = `E2E passkey ${Date.now()}`;
		const renamed = `${name} renamed`;

		const cdp = await context.newCDPSession(page);
		await cdp.send('WebAuthn.enable');
		const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true
			}
		});

		try {
			await gotoAccount(page);
			await page.locator('#account-passkey-name').fill(name);
			await page.getByRole('button', { name: 'Add passkey' }).click();

			const row = page.locator('li').filter({ hasText: name }).first();
			await expect(row).toBeVisible({ timeout: 30_000 });
			expect(
				psql(
					`select count(*) from passkey p join "user" u on u.id = p.user_id where p.name = '${name.replaceAll("'", "''")}'`
				)
			).toBe('1');

			const passkeyId = psql(
				`select id from passkey where name = '${name.replaceAll("'", "''")}' limit 1`
			);
			expect(passkeyId).not.toBe('');
			expect(
				psql(
					`select count(*) from activities where event = 'account.passkey_add' and payload->>'passkey_id' = '${passkeyId}'`
				)
			).toBe('1');

			await row.getByText('Rename', { exact: true }).click();
			await row.locator('input[name="name"]').fill(renamed);
			await row.getByRole('button', { name: 'Save name' }).click();
			await expect(page.getByText(renamed, { exact: true })).toBeVisible({ timeout: 20_000 });

			page.once('dialog', (dialog) => dialog.accept());
			const renamedRow = page.locator('li').filter({ hasText: renamed }).first();
			await renamedRow.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(page.getByText(renamed, { exact: true })).toHaveCount(0, {
				timeout: 20_000
			});
		} finally {
			await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
		}
	});
});

test.describe('passkey last-key guard', () => {
	test.beforeAll(() => {
		psql(`delete from "user" where email = '${PASSKEY_ONLY_EMAIL}'`);
	});
	test.afterAll(() => {
		psql(`delete from "user" where email = '${PASSKEY_ONLY_EMAIL}'`);
	});

	test('blocks deleting the last passkey when the account has no password', async ({
		page,
		context
	}) => {
		test.setTimeout(180_000);
		const name = 'E2E only passkey';

		const signUp = await apiPost(page, '/api/auth/sign-up/email', {
			email: PASSKEY_ONLY_EMAIL,
			name: 'E2E Passkey Only',
			password: PASSKEY_ONLY_PASSWORD
		});
		expect([200, 422]).toContain(signUp.status());
		psql(
			`update "user" set email_verified = true, role = 'admin' where email = '${PASSKEY_ONLY_EMAIL}'`
		);
		const signIn = await apiPost(page, '/api/auth/sign-in/email', {
			email: PASSKEY_ONLY_EMAIL,
			password: PASSKEY_ONLY_PASSWORD
		});
		expect(signIn.ok()).toBeTruthy();

		const cdp = await context.newCDPSession(page);
		await cdp.send('WebAuthn.enable');
		const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true
			}
		});

		try {
			await gotoAccount(page);
			await page.locator('#account-passkey-name').fill(name);
			await page.getByRole('button', { name: 'Add passkey' }).click();
			const row = page.locator('li').filter({ hasText: name }).first();
			await expect(row).toBeVisible({ timeout: 30_000 });

			// Simulate an OAuth-only account by removing the password credential
			// row; the session itself stays valid.
			psql(
				`delete from "account" where user_id = (select id from "user" where email = '${PASSKEY_ONLY_EMAIL}') and provider_id = 'credential'`
			);
			await page.reload();
			await expect(
				page.getByText('This account has no password credential.', { exact: false })
			).toBeVisible();

			page.once('dialog', (dialog) => dialog.accept());
			await row.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(page.getByRole('alert')).toContainText(/cannot delete the last passkey/i, {
				timeout: 20_000
			});
			expect(
				psql(
					`select count(*) from passkey where name = '${name}' and user_id = (select id from "user" where email = '${PASSKEY_ONLY_EMAIL}')`
				)
			).toBe('1');
		} finally {
			await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
		}
	});
});

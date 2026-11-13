import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { ORIGIN, bootstrapReader, psql, valkey } from './support';

/**
 * W1.4 acceptance: forgot password → mailed token → reset → sign in, with
 * every pre-reset session revoked. The preview has no SMTP host, so the mail
 * is dev-logged; the token read from `verification` is exactly the one the
 * link carries, and the callback URL below is the one `sendResetPassword`
 * receives, so this exercises the real chain minus the MTA hop.
 */
test.use(zhCnLocale);

const EMAIL = 'e2e-reset@example.com';
const OLD_PASSWORD = 'e2e-reset-old-1';
const NEW_PASSWORD = 'e2e-reset-new-2';

function userId(): string {
	return psql(`select id from "user" where email = '${EMAIL}'`);
}

function sessionCount(): number {
	return Number(psql(`select count(*) from session where user_id = '${userId()}'`));
}

function cleanup() {
	psql(`delete from session where user_id in (select id from "user" where email = '${EMAIL}')`);
	psql(`delete from verification where value in (select id from "user" where email = '${EMAIL}')`);
	psql(`delete from "member" where user_id in (select id from "user" where email = '${EMAIL}')`);
	psql(`delete from "user" where email = '${EMAIL}'`);
}

/** The form action buckets by client address; repeated runs must not exhaust it. */
function clearResetLimit() {
	try {
		const keys = valkey('KEYS', 'limits:password-reset:*').split('\n').filter(Boolean);
		for (const key of keys) valkey('DEL', key);
	} catch {
		// fail-open by contract: no Valkey means the limiter was never engaged.
	}
}

test.describe('password reset loop', () => {
	test.beforeAll(() => {
		cleanup();
		clearResetLimit();
	});
	test.afterAll(cleanup);

	test('bare and expired links render a recovery state, never 404', async ({ page }) => {
		const bare = await page.goto('/reset-password');
		expect(bare?.status()).toBe(200);
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('链接已失效');
		await expect(page.getByRole('link', { name: '重新获取链接' })).toBeVisible();

		const expired = await page.goto('/reset-password?error=INVALID_TOKEN');
		expect(expired?.status()).toBe(200);
		await expect(page.locator('[data-slot="card-title"]')).toHaveText('链接已失效');
	});

	test('a forged token is rejected with the recovery message', async ({ page }) => {
		await page.goto('/reset-password?token=not-a-real-token');
		await page.locator('input[name="password"]').fill('forged-password-1');
		await page.locator('input[name="confirmPassword"]').fill('forged-password-1');
		await page.locator('button[type="submit"]').click();
		await expect(page.getByRole('alert')).toContainText('无效或已过期');
	});

	test('request → token → reset → sign in, and every old session dies', async ({ browser }) => {
		test.setTimeout(120_000);

		// Fixture: a verified reader with a password and two live sessions.
		const setup = await browser.newContext({ storageState: zhCnLocale.storageState });
		await bootstrapReader(setup, EMAIL, OLD_PASSWORD);
		const extra = await setup.request.post('/api/auth/sign-in/email', {
			data: { email: EMAIL, password: OLD_PASSWORD },
			headers: { origin: ORIGIN }
		});
		expect(extra.ok()).toBeTruthy();
		expect(sessionCount()).toBeGreaterThan(0);
		await setup.close();

		const context = await browser.newContext({ storageState: zhCnLocale.storageState });
		const page = await context.newPage();

		// Request: the form reaches better-auth and always answers success.
		await page.goto('/forgot-password');
		await page.locator('input[name="email"]').fill(EMAIL);
		await page.locator('button[type="submit"]').click();
		await expect(page.getByRole('status')).toContainText('重置链接');

		const identifier = psql(
			`select identifier from verification where value = '${userId()}' ` +
				`and identifier like 'reset-password:%' order by created_at desc limit 1`
		);
		expect(identifier).toMatch(/^reset-password:.+/);
		const token = identifier.slice('reset-password:'.length);

		// The mailed link: better-auth verifies the token, then redirects to us.
		await page.goto(`/api/auth/reset-password/${token}?callbackURL=%2Freset-password`);
		await expect(page).toHaveURL(/\/reset-password\?token=/);
		await page.locator('input[name="password"]').fill(NEW_PASSWORD);
		await page.locator('input[name="confirmPassword"]').fill(NEW_PASSWORD);
		await page.locator('button[type="submit"]').click();

		await expect(page).toHaveURL(/\/login\?message=password-reset-success/);
		await expect(page.getByRole('status')).toContainText('密码已重置');
		// revokeSessionsOnPasswordReset: nothing minted before the reset survives.
		expect(sessionCount()).toBe(0);

		// The new password works (and the old one would not). Scope the click to
		// the email form: the login page also has a GitHub submit button.
		await page.locator('input[name="email"]').fill(EMAIL);
		await page.locator('input[name="password"]').fill(NEW_PASSWORD);
		await page.locator('form[action="?/signIn"] button[type="submit"]').click();
		await expect(page).toHaveURL(/\/admin\//);
		expect(sessionCount()).toBeGreaterThan(0);

		await context.close();
	});
});

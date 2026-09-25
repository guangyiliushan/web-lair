import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * B3.1 acceptance for the admin 2FA challenge (TOTP + backup codes + reset).
 *
 * The fixture account is created and armed through the HTTP API: a two_factor
 * secret is stored encrypted, so it cannot be seeded with SQL. TOTP codes are
 * computed locally (RFC 6238, SHA-1, 30s step). Fixture rows are namespaced and
 * removed in teardown; `pnpm db:reset-2fa` is exercised as the documented
 * emergency recovery path.
 */
const FIXTURE_EMAIL = 'e2e-2fa@example.com';
const FIXTURE_PASSWORD = 'e2e-2fa-password-1';
const FIXTURE_NAME = 'E2E 2FA';
const ORIGIN = 'http://localhost:4173';

function envValue(key: string): string {
	const raw = readFileSync('.env', 'utf8');
	const match = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
	const value = match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
	if (!value) throw new Error(`${key} missing in .env`);
	return value;
}

const LOGIN_SLUG = envValue('ADMIN_LOGIN_SLUG');
const TWO_FACTOR_PATH = `/admin/${LOGIN_SLUG}/two-factor`;

/**
 * The two-factor page URL itself starts with /admin, so a bare /\/admin/
 * matches it instantly - waits must use this predicate so the follow-up
 * assertions cannot race the verify round-trip (B3.1 regression: the probe
 * showed "no session cookie" only because it ran before the 302 arrived).
 */
const isAdminDestination = (url: URL) =>
	url.pathname.startsWith('/admin') && !url.pathname.includes('/two-factor');

function psql(sql: string): string {
	return execFileSync(
		'docker',
		['exec', '-i', 'web-lair-db-1', 'psql', '-U', 'root', '-d', 'local', '-tAc', sql],
		{ encoding: 'utf8' }
	).trim();
}

function runResetScript(): string {
	return execFileSync('pnpm', ['db:reset-2fa', FIXTURE_EMAIL], {
		encoding: 'utf8',
		shell: true,
		timeout: 150_000
	});
}

/** RFC 6238, SHA-1, 6 digits, 30s step - matches better-auth's TOTP usage. */
function totpCode(totpSecret: string, timestamp = Date.now()): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of totpSecret.replace(/=+$/, '').toUpperCase()) {
		const index = alphabet.indexOf(char);
		if (index === -1) continue;
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}

	const counter = Math.floor(timestamp / 1000 / 30);
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', Buffer.from(bytes)).update(buffer).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const code =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);

	return (code % 1_000_000).toString().padStart(6, '0');
}

/**
 * better-auth's rate limiter is ACTIVE in the production preview (`enabled`
 * defaults to isProduction) and, without a resolvable client IP, keys buckets
 * by path alone: /sign-in*|/sign-up*|/change-* allow 3 per rolling 10s chain
 * and the two-factor plugin allows 3 per 10s for /two-factor/* (probed: the
 * 4th rapid call answers 429 + X-Retry-After, reset needs ~10s idle).
 * Pace those calls with the same rule so a full run never trips the limiter.
 */
const RATE_LIMITED = /^\/(sign-in|sign-up|change-password|change-email|two-factor)\//;
const RATE_WINDOW_MS = 10_500;
const RATE_MAX = 3;
const rateGates = new Map<string, { count: number; last: number }>();

async function apiPost(page: Page, path: string, data: Record<string, unknown>) {
	const apiPath = path.replace(/^\/api\/auth/, '');
	if (RATE_LIMITED.test(apiPath)) {
		const now = Date.now();
		const state = rateGates.get(apiPath) ?? { count: 0, last: 0 };
		if (now - state.last >= RATE_WINDOW_MS) {
			state.count = 0;
		} else if (state.count >= RATE_MAX) {
			// The limiter resets after a >=10s idle gap from the last request.
			await new Promise((resolve) => setTimeout(resolve, RATE_WINDOW_MS - (now - state.last)));
			state.count = 0;
		}
		state.count += 1;
		state.last = Date.now();
		rateGates.set(apiPath, state);
	}
	return page.request.post(path, { data, headers: { origin: ORIGIN } });
}

/** verify-totp through the API, with retries across a 30s window / 10s rate window. */
async function verifyTotpViaApi(page: Page, totpSecret: string) {
	let lastStatus = 0;
	let lastBody = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await apiPost(page, '/api/auth/two-factor/verify-totp', {
			code: totpCode(totpSecret)
		});
		if (response.ok()) return response;
		lastStatus = response.status();
		lastBody = await response.text();
		if (lastStatus === 429) {
			// plugin-level rate limit for /two-factor/ (10s chain) - wait it out
			const retryAfter = Number(response.headers()['x-retry-after'] ?? 11);
			await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
			continue;
		}
		const secondsLeftInWindow = 30 - (Math.floor(Date.now() / 1000) % 30);
		await new Promise((resolve) => setTimeout(resolve, (secondsLeftInWindow + 1) * 1000));
	}
	throw new Error(`verify-totp kept failing: status=${lastStatus} body=${lastBody}`);
}

function sessionCount(): string {
	return psql(
		`select count(*) from "session" s join "user" u on u.id = s.user_id where u.email = '${FIXTURE_EMAIL}'`
	);
}

function challengeSignIn(page: Page) {
	return apiPost(page, '/api/auth/sign-in/email', {
		email: FIXTURE_EMAIL,
		password: FIXTURE_PASSWORD
	});
}

test.describe.configure({ mode: 'serial' });

let secret = '';
let backupCode = '';

test.beforeAll(() => {
	psql(
		`delete from "verification" where "identifier" like '2fa-%' or "identifier" like 'trust-device-%'`
	);
	psql(`delete from "member" where id = 'e2e-2fa-member'`);
	psql(`delete from "user" where email = '${FIXTURE_EMAIL}'`);
});

test.afterAll(() => {
	psql(`delete from "member" where id = 'e2e-2fa-member'`);
	psql(`delete from "user" where email = '${FIXTURE_EMAIL}'`);
	psql(
		`delete from "verification" where "identifier" like '2fa-%' or "identifier" like 'trust-device-%'`
	);
});

test('setup: the fixture account gets TOTP armed through the API', async ({ page }) => {
	const signUp = await apiPost(page, '/api/auth/sign-up/email', {
		email: FIXTURE_EMAIL,
		name: FIXTURE_NAME,
		password: FIXTURE_PASSWORD
	});
	expect(signUp.ok()).toBeTruthy();

	// Admission fixture: verified email + a reviewer membership in the site org.
	psql(`update "user" set email_verified = true where email = '${FIXTURE_EMAIL}'`);
	psql(
		`insert into "member" (id, organization_id, user_id, role, created_at)
		 select 'e2e-2fa-member', o.id, u.id, 'reviewer', now()
		 from organization o, "user" u
		 where o.slug = 'web-lair' and u.email = '${FIXTURE_EMAIL}'
		 on conflict (id) do nothing`
	);

	// Establish a fixture session explicitly: depending on the emailVerification
	// configuration a fresh sign-up may not auto-sign-in.
	const signIn = await apiPost(page, '/api/auth/sign-in/email', {
		email: FIXTURE_EMAIL,
		password: FIXTURE_PASSWORD
	});
	expect(signIn.ok()).toBeTruthy();

	const enable = await apiPost(page, '/api/auth/two-factor/enable', {
		password: FIXTURE_PASSWORD
	});
	expect(enable.ok()).toBeTruthy();
	const payload = (await enable.json()) as { totpURI: string; backupCodes: string[] };
	secret = /[?&]secret=([^&]+)/.exec(payload.totpURI)?.[1] ?? '';
	backupCode = payload.backupCodes[0] ?? '';
	expect(secret).not.toBe('');
	expect(backupCode).not.toBe('');

	// First code activates the factor (the challenge cookie from enable rides along).
	await verifyTotpViaApi(page, secret);
	expect(psql(`select two_factor_enabled from "user" where email = '${FIXTURE_EMAIL}'`)).toBe('t');
});

test('the challenge page rejects a wrong code, then accepts the right one', async ({ page }) => {
	await apiPost(page, '/api/auth/sign-out', {});
	// Sessions are rows, not context state: the fixture session from the setup
	// survives this fresh browser context, so clear the rows to measure exactly
	// what a challenge sign-in leaves behind.
	psql(
		`delete from "session" where user_id = (select id from "user" where email = '${FIXTURE_EMAIL}')`
	);
	const signIn = await challengeSignIn(page);
	expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
	// No session was created before the second factor:
	expect(sessionCount()).toBe('0');

	await page.goto(TWO_FACTOR_PATH);
	await expect(page.getByRole('button', { name: /verify/i })).toBeVisible({ timeout: 10000 });

	// A guaranteed-wrong code: the current valid code with its first digit bumped.
	const valid = totpCode(secret);
	const wrong = `${(Number(valid[0]) + 1) % 10}${valid.slice(1)}`;
	await page.locator('input[name="code"]').fill(wrong);
	await page.getByRole('button', { name: /verify/i }).click();
	await expect(page.getByRole('alert')).toContainText(/invalid verification code/i, {
		timeout: 10000
	});

	// The right code completes the challenge; a clock-boundary rollover retries.
	await expect(async () => {
		await page.locator('input[name="code"]').fill(totpCode(secret));
		await page.getByRole('button', { name: /verify/i }).click();
		await page.waitForURL(isAdminDestination, { timeout: 3000 });
	}).toPass({ timeout: 40_000 });

	expect(sessionCount()).toBe('1');
});

test('a backup code works exactly once', async ({ page }) => {
	await apiPost(page, '/api/auth/sign-out', {});
	await challengeSignIn(page);

	await page.goto(TWO_FACTOR_PATH);
	await page.getByRole('button', { name: /backup/i }).click();
	await page.locator('input[name="code"]').fill(backupCode);
	await page.getByRole('button', { name: /verify/i }).click();
	await page.waitForURL(isAdminDestination, { timeout: 10000 });
	await apiPost(page, '/api/auth/sign-out', {});
	await challengeSignIn(page);
	await page.goto(TWO_FACTOR_PATH);
	await page.getByRole('button', { name: /backup/i }).click();
	await page.locator('input[name="code"]').fill(backupCode);
	await page.getByRole('button', { name: /verify/i }).click();
	await expect(page.getByRole('alert')).toBeVisible({ timeout: 10000 });
});

test('the challenge page never auto-signs-in through the Tailnet hand-off', async ({ page }) => {
	await apiPost(page, '/api/auth/sign-out', {});
	await page.goto(TWO_FACTOR_PATH);
	// Without the hooks exemption this load hands off to the Tailnet endpoint,
	// gets a real session and bounces to /admin - the form must win instead.
	await expect(page.getByRole('button', { name: /verify/i })).toBeVisible({ timeout: 10000 });
	await expect(page).toHaveURL(new RegExp(`${TWO_FACTOR_PATH.replaceAll('/', '\\/')}$`));
});

test('db:reset-2fa disables the factor, revokes sessions, and is idempotent', async ({ page }) => {
	// Two pnpm invocations (tsx cold start each) blow past the 30s default.
	test.setTimeout(180_000);

	const signInResponse = await challengeSignIn(page);
	expect(signInResponse.ok()).toBeTruthy();
	await verifyTotpViaApi(page, secret);
	expect(sessionCount()).toBe('1');

	const first = runResetScript();
	expect(first).toContain('twoFactorEnabled=false');
	expect(first).toContain('sessions=0');
	expect(first).toContain('Reset at');
	expect(psql(`select two_factor_enabled from "user" where email = '${FIXTURE_EMAIL}'`)).toBe('f');
	expect(
		psql(
			`select count(*) from "verification" where "identifier" like '2fa-%' or "identifier" like 'trust-device-%'`
		)
	).toBe('0');

	const second = runResetScript();
	expect(second).toContain('nothing to reset.');

	// Password sign-in no longer gets challenged after the reset.
	const signIn = await challengeSignIn(page);
	const body = (await signIn.json()) as { twoFactorRedirect?: boolean };
	expect(body.twoFactorRedirect ?? false).toBe(false);
});

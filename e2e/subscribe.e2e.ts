import { createHash, createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql, valkeyDel } from './support';
import { TEST_MAIL_EVENTS_HMAC_KEY, TEST_SUPPRESSION_HMAC_KEY } from './test-keys';

/**
 * Deploy batch D-2 acceptance: the double opt-in subscription chain on the
 * real schema. Mail itself is not asserted here (the transport is a unit
 * concern); the DB row is the observable evidence — and the GET confirm page
 * must NOT mutate state (mail scanners prefetch links).
 *
 * Marker rows are removed before and after; the unsubscribe step keeps the row
 * (suppression list) and is cleaned by the same LIKE delete.
 */
const MARKER = `e2e-sub-${Date.now()}@example.com`;
const SUPPRESSION_HASHES: string[] = [];

function emailHash(email: string): string {
	return createHmac('sha256', Buffer.from(TEST_SUPPRESSION_HMAC_KEY, 'base64'))
		.update(email)
		.digest('hex');
}

function trackSuppression(email: string): string {
	const hash = emailHash(email);
	if (!SUPPRESSION_HASHES.includes(hash)) SUPPRESSION_HASHES.push(hash);
	return hash;
}

function cleanupDb(): void {
	psql(`delete from subscriptions where email like 'e2e-sub-%'`);
	if (SUPPRESSION_HASHES.length > 0) {
		psql(
			`delete from email_suppressions where email_hash in (${SUPPRESSION_HASHES.map((hash) => `'${hash}'`).join(',')})`
		);
	}
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanupDb();
	// The subscribe action keeps a 10/hour per-address bucket in Valkey; repeat
	// runs of this spec would otherwise 429 their own second submission.
	valkeyDel('wl:limits:subscribe:127.0.0.1');
	valkeyDel('wl:limits:subscribe:::1');
	// One-click is capped at 30/min per IP; clear it so reruns start clean.
	valkeyDel('wl:limits:unsubscribe-oneclick:127.0.0.1');
	valkeyDel('wl:limits:unsubscribe-oneclick:::1');
});

test.afterAll(() => {
	cleanupDb();
});

test.describe('subscription double opt-in', () => {
	test('subscribe -> confirm page -> POST confirms -> unsubscribe', async ({ page }) => {
		await page.goto('/zh-cn/subscribe');
		await expect(page.getByLabel('邮箱')).toBeVisible({ timeout: 20_000 });

		await page.getByLabel('邮箱').fill(MARKER);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });

		const token = psql(`select token from subscriptions where email = '${MARKER}'`);
		expect(token).toHaveLength(43);
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('pending');
		expect(psql(`select consent_version from subscriptions where email = '${MARKER}'`)).toBe(
			'2026-10-v1'
		);
		expect(psql(`select token_hash from subscriptions where email = '${MARKER}'`)).toBe(
			createHash('sha256').update(token).digest('hex')
		);

		// Prefetch-safety: opening the link must not confirm the address.
		const confirmResponse = await page.goto(`/zh-cn/subscribe/confirm?token=${token}`);
		// strict-origin keeps the token out of Referer without nulling Origin
		// (no-referrer makes Chromium send Origin: null and the POST 403s).
		expect(confirmResponse?.headers()['referrer-policy']).toBe('strict-origin');
		await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible({
			timeout: 20_000
		});
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('pending');

		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('subscribed');
		const verifiedAt = psql(`select verified_at from subscriptions where email = '${MARKER}'`);
		expect(verifiedAt).not.toBe('');

		// Re-submitting a confirmed address must be a no-op (no token rotation,
		// no downgrade to pending) — the public form cannot un-confirm a reader.
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(MARKER);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('subscribed');
		expect(psql(`select token from subscriptions where email = '${MARKER}'`)).toBe(token);
		expect(psql(`select verified_at from subscriptions where email = '${MARKER}'`)).toBe(
			verifiedAt
		);

		const unsubscribeResponse = await page.goto(`/zh-cn/unsubscribe?token=${token}`);
		expect(unsubscribeResponse?.headers()['referrer-policy']).toBe('strict-origin');
		await page.getByRole('button', { name: '退订', exact: true }).click();
		await expect(page.getByText('已退订')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('unsubscribed');
		expect(
			psql(`select reason from email_suppressions where email_hash = '${trackSuppression(MARKER)}'`)
		).toBe('unsubscribed');
		const unsubscribedAt = psql(
			`select unsubscribed_at from subscriptions where email = '${MARKER}'`
		);
		expect(unsubscribedAt).not.toBe('');

		// Idempotency: reopening the link shows the terminal state (no button), and
		// a direct POST returns 200 without rewriting the suppression timestamp.
		await page.goto(`/zh-cn/unsubscribe?token=${token}`);
		// A GET on an unsubscribed token renders the terminal state (the service
		// only returns 'already-unsubscribed' to a POST).
		await expect(page.getByText('已退订')).toBeVisible({ timeout: 15_000 });
		const repeat = await page.request.post('/zh-cn/unsubscribe', {
			form: { token },
			headers: { origin: 'http://localhost:4173' }
		});
		expect(repeat.status()).toBe(200);
		expect(psql(`select unsubscribed_at from subscriptions where email = '${MARKER}'`)).toBe(
			unsubscribedAt
		);
	});

	test('unsubscribe on a pending row removes it instead of violating the CHECK', async ({
		page
	}) => {
		const pending = `e2e-sub-pending-${Date.now()}@example.com`;
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(pending);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });

		const token = psql(`select token from subscriptions where email = '${pending}'`);
		expect(token).toHaveLength(43);

		await page.goto(`/zh-cn/unsubscribe?token=${token}`);
		await page.getByRole('button', { name: '退订', exact: true }).click();
		await expect(page.getByText('已退订')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select count(*)::int from subscriptions where email = '${pending}'`)).toBe('0');
		expect(
			psql(
				`select reason from email_suppressions where email_hash = '${trackSuppression(pending)}'`
			)
		).toBe('unsubscribed');
	});

	test('honeypot submissions succeed without creating a row', async ({ page }) => {
		const bot = `e2e-sub-bot-${Date.now()}@example.com`;
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(bot);
		// The honeypot is visually hidden; set the value through the DOM.
		await page.evaluate(() => {
			const input = document.querySelector<HTMLInputElement>('input[name="website"]');
			if (input) input.value = 'https://spam.example';
		});
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select count(*)::int from subscriptions where email = '${bot}'`)).toBe('0');
	});

	test('a confirmation link older than the TTL is refused and a resubmit refreshes it', async ({
		page
	}) => {
		const email = `e2e-sub-expired-${Date.now()}@example.com`;
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });

		const token = psql(`select token from subscriptions where email = '${email}'`);
		expect(token).toHaveLength(43);
		psql(
			`update subscriptions set updated_at = now() - interval '8 days' where email = '${email}'`
		);

		await page.goto(`/zh-cn/subscribe/confirm?token=${token}`);
		await expect(page.getByText('确认链接已过期')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0);

		// A direct POST cannot bypass the TTL either, and must not write.
		const refused = await page.request.post('/zh-cn/subscribe/confirm', {
			form: { token },
			headers: { origin: 'http://localhost:4173' }
		});
		expect(refused.status()).toBe(200);
		expect(psql(`select status from subscriptions where email = '${email}'`)).toBe('pending');

		// Resubmitting rotates the token and starts a fresh window.
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		const fresh = psql(`select token from subscriptions where email = '${email}'`);
		expect(fresh).toHaveLength(43);
		expect(fresh).not.toBe(token);
		expect(
			psql(
				`select updated_at > now() - interval '1 minute' from subscriptions where email = '${email}'`
			)
		).toBe('t');

		await page.goto(`/zh-cn/subscribe/confirm?token=${fresh}`);
		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });
	});

	test('RFC 8058 one-click POST works without Origin and is idempotent', async ({ page }) => {
		const email = `e2e-sub-oneclick-${Date.now()}@example.com`;
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });

		const token = psql(`select token from subscriptions where email = '${email}'`);
		await page.goto(`/zh-cn/subscribe/confirm?token=${token}`);
		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });

		// No Origin header and no cookies are sent by a mail receiver.
		const response = await page.request.post(`/api/unsubscribe/one-click?token=${token}`, {
			form: { 'List-Unsubscribe': 'One-Click' }
		});
		expect(response.status()).toBe(200);
		expect(await response.text()).toBe('');
		expect(psql(`select status from subscriptions where email = '${email}'`)).toBe('unsubscribed');

		const again = await page.request.post(`/api/unsubscribe/one-click?token=${token}`, {
			form: { 'List-Unsubscribe': 'One-Click' }
		});
		expect(again.status()).toBe(200);
		expect(psql(`select status from subscriptions where email = '${email}'`)).toBe('unsubscribed');
	});

	test('a soft unsubscribe allows a fresh confirmation and lifts the suppression', async ({
		page
	}) => {
		valkeyDel('wl:limits:subscribe:127.0.0.1');
		valkeyDel('wl:limits:subscribe:::1');
		const email = `e2e-sub-soft-${Date.now()}@example.com`;
		const hash = trackSuppression(email);
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		const firstToken = psql(`select token from subscriptions where email = '${email}'`);

		await page.goto(`/zh-cn/unsubscribe?token=${firstToken}`);
		await page.getByRole('button', { name: '退订', exact: true }).click();
		await expect(page.getByText('已退订')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select reason from email_suppressions where email_hash = '${hash}'`)).toBe(
			'unsubscribed'
		);

		// D-1: the reader may submit the form again; the soft suppression does
		// not block the confirmation mail. Confirming then lifts the record.
		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		const fresh = psql(`select token from subscriptions where email = '${email}'`);
		expect(fresh).toHaveLength(43);
		await page.goto(`/zh-cn/subscribe/confirm?token=${fresh}`);
		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select count(*)::int from email_suppressions where email_hash = '${hash}'`)).toBe(
			'0'
		);
	});

	test('a hard-bounce suppression blocks the form without creating a row', async ({ page }) => {
		valkeyDel('wl:limits:subscribe:127.0.0.1');
		valkeyDel('wl:limits:subscribe:::1');
		const email = `e2e-sub-bounce-${Date.now()}@example.com`;
		const hash = trackSuppression(email);
		psql(
			`insert into email_suppressions (email_hash, reason, source) values ('${hash}', 'bounced', 'e2e')`
		);

		await page.goto('/zh-cn/subscribe');
		await page.getByLabel('邮箱').fill(email);
		await page.getByRole('button', { name: '订阅', exact: true }).click();
		await expect(page.getByText('请查收邮件')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select count(*)::int from subscriptions where email = '${email}'`)).toBe('0');
		expect(psql(`select reason from email_suppressions where email_hash = '${hash}'`)).toBe(
			'bounced'
		);
	});

	test('a signed complaint reaches the suppression row and upgrades a soft opt-out', async ({
		page
	}) => {
		const email = `e2e-sub-complaint-${Date.now()}@example.com`;
		const hash = trackSuppression(email);
		psql(
			`insert into email_suppressions (email_hash, reason, source) values ('${hash}', 'unsubscribed', 'e2e')`
		);

		const body = JSON.stringify({ email, reason: 'complained' });
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac('sha256', Buffer.from(TEST_MAIL_EVENTS_HMAC_KEY, 'base64'))
			.update(`${timestamp}.${body}`)
			.digest('hex');
		const response = await page.request.post('/api/mail/events', {
			data: body,
			headers: {
				'content-type': 'application/json',
				'x-mail-events-timestamp': timestamp,
				'x-mail-events-signature': `sha256=${signature}`
			}
		});
		expect(response.status()).toBe(200);
		expect(psql(`select reason from email_suppressions where email_hash = '${hash}'`)).toBe(
			'complained'
		);

		// A later, weaker event must not downgrade the complaint.
		const downgradeBody = JSON.stringify({ email, reason: 'bounced' });
		const downgradeTs = String(Math.floor(Date.now() / 1000));
		const downgradeSig = createHmac('sha256', Buffer.from(TEST_MAIL_EVENTS_HMAC_KEY, 'base64'))
			.update(`${downgradeTs}.${downgradeBody}`)
			.digest('hex');
		const downgrade = await page.request.post('/api/mail/events', {
			data: downgradeBody,
			headers: {
				'content-type': 'application/json',
				'x-mail-events-timestamp': downgradeTs,
				'x-mail-events-signature': `sha256=${downgradeSig}`
			}
		});
		expect(downgrade.status()).toBe(200);
		expect(psql(`select reason from email_suppressions where email_hash = '${hash}'`)).toBe(
			'complained'
		);
		expect(psql(`select source from email_suppressions where email_hash = '${hash}'`)).toBe(
			'mail-events'
		);

		// Unsigned requests are rejected once the key is configured.
		const unsigned = await page.request.post('/api/mail/events', {
			data: { email, reason: 'bounced' }
		});
		expect(unsigned.status()).toBe(401);
	});

	test('confirming a pending token never lifts a hard suppression', async ({ page }) => {
		const email = `e2e-sub-hard-lift-${Date.now()}@example.com`;
		const hash = trackSuppression(email);
		const token = 'z'.repeat(43);
		psql(
			`insert into email_suppressions (email_hash, reason, source) values ('${hash}', 'complained', 'e2e')`
		);
		psql(
			`insert into subscriptions (email, status, token, lang, source) values ('${email}', 'pending', '${token}', 'zh-cn', 'e2e')`
		);

		await page.goto(`/zh-cn/subscribe/confirm?token=${token}`);
		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${email}'`)).toBe('subscribed');
		expect(psql(`select reason from email_suppressions where email_hash = '${hash}'`)).toBe(
			'complained'
		);
	});

	test('CSRF: origin-less and cross-origin form posts are refused', async ({ page }) => {
		valkeyDel('wl:limits:subscribe:127.0.0.1');
		valkeyDel('wl:limits:subscribe:::1');
		const email = `e2e-sub-csrf-${Date.now()}@example.com`;

		const noOrigin = await page.request.post('/zh-cn/subscribe', { form: { email } });
		expect(noOrigin.status()).toBe(403);

		const crossOrigin = await page.request.post('/zh-cn/subscribe', {
			form: { email },
			headers: { origin: 'https://evil.example' }
		});
		expect(crossOrigin.status()).toBe(403);
		expect(psql(`select count(*)::int from subscriptions where email = '${email}'`)).toBe('0');

		// The same-origin header path still reaches the action.
		const sameOrigin = await page.request.post('/zh-cn/subscribe', {
			form: { email },
			headers: { origin: 'http://localhost:4173' }
		});
		expect(sameOrigin.status()).toBe(200);
		expect(psql(`select count(*)::int from subscriptions where email = '${email}'`)).toBe('1');
	});
});

import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

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

function cleanupDb(): void {
	psql(`delete from subscriptions where email like 'e2e-sub-%'`);
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanupDb();
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

		// Prefetch-safety: opening the link must not confirm the address.
		await page.goto(`/zh-cn/subscribe/confirm?token=${token}`);
		await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible({
			timeout: 20_000
		});
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('pending');

		await page.getByRole('button', { name: '确认', exact: true }).click();
		await expect(page.getByText('订阅已确认')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('subscribed');
		expect(
			psql(`select verified_at is not null from subscriptions where email = '${MARKER}'`)
		).toBe('t');

		await page.goto(`/zh-cn/unsubscribe?token=${token}`);
		await page.getByRole('button', { name: '退订', exact: true }).click();
		await expect(page.getByText('已退订')).toBeVisible({ timeout: 15_000 });
		expect(psql(`select status from subscriptions where email = '${MARKER}'`)).toBe('unsubscribed');
		expect(
			psql(`select unsubscribed_at is not null from subscriptions where email = '${MARKER}'`)
		).toBe('t');
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
});

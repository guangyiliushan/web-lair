import { expect, test } from '@playwright/test';

/**
 * W6.3: the public privacy notice is a real page, linked from registration and
 * comment forms. This is a route-existence + content smoke check (the copy is
 * i18n-reviewed separately).
 */
test('privacy policy answers 200 with its core sections', async ({ page }) => {
	const response = await page.goto('/privacy');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
	for (const heading of [
		'Account',
		'Comments',
		'IP addresses and security',
		'Cookies',
		'Retention',
		'Your rights'
	]) {
		await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
	}
});

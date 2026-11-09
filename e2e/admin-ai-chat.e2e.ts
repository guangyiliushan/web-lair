import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

/**
 * Read-only agent chat (v3 phase 5 slice): the page creates a conversation,
 * shows the empty state, and hard-deletes it. The send path needs a configured
 * provider and is covered by unit-level tool tests later.
 */
test('creates and deletes a chat conversation', async ({ page }) => {
	await page.goto('/admin/ai/chat');
	await expect(page.getByRole('heading', { name: '管理对话' })).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: '新建会话' }).click();
	await expect(page.getByText('问站点状态、最近用量或内容库。')).toBeVisible({ timeout: 15000 });

	// No provider is assigned to `chat` in the fixture DB, so the SSE route
	// must surface a visible error instead of hanging or silently dropping it.
	await page.locator('textarea[name="text"]').fill('站点现在有多少篇文章？');
	await page.getByRole('button', { name: '发送' }).click();
	await expect(page.getByRole('alert')).toBeVisible({ timeout: 20000 });

	page.on('dialog', (dialog) => void dialog.accept());
	await page.getByRole('button', { name: '删除会话' }).click();
	await expect(page.getByText('问站点状态、最近用量或内容库。')).toHaveCount(0, {
		timeout: 15000
	});
	await expect(page.getByText('还没有对话').first()).toBeVisible({ timeout: 15000 });
});

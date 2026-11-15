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
	// The header action is registered during hydration; wait for the network to
	// settle so the click cannot land before the registry exists.
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('heading', { name: '管理对话' })).toBeVisible({ timeout: 15000 });

	const newButton = page.getByRole('button', { name: '新建', exact: true });
	await expect(newButton).toBeEnabled({ timeout: 15000 });
	await newButton.click();
	await expect(page.getByText('问站点状态、最近用量或内容库。')).toBeVisible({ timeout: 15000 });

	// No provider is assigned to `chat` in the fixture DB: the composer is
	// disabled and the readiness strip names the reason, so there is no send
	// path to exercise here.
	await expect(page.getByTestId('chat-readiness')).toBeVisible({ timeout: 20000 });
	await expect(page.locator('textarea[name="text"]')).toBeDisabled();

	page.on('dialog', (dialog) => void dialog.accept());
	await page.getByRole('button', { name: '删除会话' }).click();
	await expect(page.getByText('问站点状态、最近用量或内容库。')).toHaveCount(0, {
		timeout: 15000
	});
	await expect(page.getByText('还没有对话').first()).toBeVisible({ timeout: 15000 });
});

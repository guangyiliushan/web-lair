import { test, expect } from '@playwright/test';

// The block handle toolbar and its menu are hard-coded Chinese (the app pins
// its locale to zh-cn client-side; the toolbar's own aria-labels come from the
// zh-cn message set: 块操作 / 添加块). Menu labels: 转换为 / 操作 / 复制块 ...
test.describe('BlockHandleToolbar', () => {
	test('toolbar appears when hovering a block in the editor', async ({ page }) => {
		await page.goto('/admin/posts/edit');

		// Wait for the Lexical editor to be ready
		const editor = page.locator('[data-lexical-editor]');
		await expect(editor).toBeVisible({ timeout: 10000 });

		// Find the first block (direct child paragraph of the editor root)
		const firstBlock = editor.locator(':scope > :first-child');
		await expect(firstBlock).toBeVisible();

		// Hover over the first block
		await firstBlock.hover();

		// The block handle toolbar should appear (mounted to document.body).
		// It is always in the DOM and only toggles opacity, so visibility must
		// be asserted on the computed style — toBeVisible() cannot see it.
		const toolbar = page.locator('[role="toolbar"][aria-label="块操作"]');
		await expect
			.poll(async () => toolbar.evaluate((el) => getComputedStyle(el).opacity), {
				timeout: 3000
			})
			.toBe('1');
	});

	test('add block button inserts a new paragraph after current block', async ({ page }) => {
		await page.goto('/admin/posts/edit');

		const editor = page.locator('[data-lexical-editor]');
		await expect(editor).toBeVisible({ timeout: 10000 });

		// Count initial blocks
		const initialBlockCount = await editor.locator(':scope > *').count();

		// Hover first block
		const firstBlock = editor.locator(':scope > :first-child');
		await firstBlock.hover();

		// Click the add block button
		const addButton = page.locator('button[aria-label="添加块"]');
		await expect(addButton).toBeVisible({ timeout: 3000 });
		await addButton.click();

		// Should have one more block
		await expect(editor.locator(':scope > *')).toHaveCount(initialBlockCount + 1);
	});

	test('dropdown menu opens and contains all expected items', async ({ page }) => {
		await page.goto('/admin/posts/edit');

		const editor = page.locator('[data-lexical-editor]');
		await expect(editor).toBeVisible({ timeout: 10000 });

		// Hover first block
		const firstBlock = editor.locator(':scope > :first-child');
		await firstBlock.hover();

		// Click the grip-vertical button to open dropdown
		const gripButton = page.locator('button[aria-label="块操作"]');
		await expect(gripButton).toBeVisible({ timeout: 3000 });
		await gripButton.click();

		// Verify dropdown menu appears
		const menu = page.locator('[data-slot="dropdown-menu-content"]');
		await expect(menu).toBeVisible({ timeout: 2000 });

		// Check TURN INTO section
		await expect(menu.getByText('转换为')).toBeVisible();
		await expect(menu.getByText('文本')).toBeVisible();
		await expect(menu.getByText('标题 1')).toBeVisible();

		// Check ACTIONS section
		await expect(menu.getByText('操作')).toBeVisible();
		await expect(menu.getByText('复制块')).toBeVisible();
		await expect(menu.getByText('上移')).toBeVisible();
		await expect(menu.getByText('下移')).toBeVisible();

		// Check Delete
		await expect(menu.getByText('删除')).toBeVisible();
	});

	test('toolbar hides after mouse leaves the block', async ({ page }) => {
		await page.goto('/admin/posts/edit');

		const editor = page.locator('[data-lexical-editor]');
		await expect(editor).toBeVisible({ timeout: 10000 });

		const firstBlock = editor.locator(':scope > :first-child');
		await firstBlock.hover();

		// Wait for the toolbar to appear (opacity toggles; see t1 note)
		const toolbar = page.locator('[role="toolbar"][aria-label="块操作"]');
		await expect
			.poll(async () => toolbar.evaluate((el) => getComputedStyle(el).opacity), {
				timeout: 3000
			})
			.toBe('1');

		// Move the pointer to a guaranteed-outside point (viewport corner,
		// over the sidebar): element-hover targets inside the shell did not
		// reliably fire the editor root's mouseleave.
		await page.mouse.move(2, 2);

		// The toolbar hides via opacity-0 while staying in the DOM, and
		// Playwright's visibility check does not treat opacity:0 as hidden -
		// poll the computed opacity instead.
		await expect
			.poll(async () => toolbar.evaluate((el) => window.getComputedStyle(el).opacity), {
				timeout: 2000
			})
			.toBe('0');
	});

	test('delete block removes it from the editor', async ({ page }) => {
		await page.goto('/admin/posts/edit');

		const editor = page.locator('[data-lexical-editor]');
		await expect(editor).toBeVisible({ timeout: 10000 });

		// A fresh editor holds exactly one empty paragraph and Lexical
		// re-inserts an empty paragraph when the last block is removed, so
		// add a block first and assert the count moves 2 -> 1.
		const firstBlock = editor.locator(':scope > :first-child');
		await firstBlock.hover();
		await page.locator('button[aria-label="添加块"]').click();
		await expect(editor.locator(':scope > *')).toHaveCount(2);

		// Hover first block again
		await firstBlock.hover();

		// Open the grip menu
		const gripButton = page.locator('button[aria-label="块操作"]');
		await expect(gripButton).toBeVisible({ timeout: 3000 });
		await gripButton.click();

		// Click Delete
		const deleteItem = page.locator('[data-slot="dropdown-menu-content"]').getByText('删除');
		await expect(deleteItem).toBeVisible();
		await deleteItem.click();

		// Should have one fewer block
		await expect(editor.locator(':scope > *')).toHaveCount(1);
	});
});

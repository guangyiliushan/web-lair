import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { editorToolbar, mountEditorFixture, readSaved } from './editor-spec-helpers';

/**
 * The "Insert" menu carries the structural inserts that had no toolbar entry
 * (footnote / mention / details / card / mermaid / tabs / columns). Their
 * nodes and round-trip transformers already existed - these tests pin that the
 * ENTRY POINT actually reaches them, and that the exported markdown survives
 * a code-mode round trip.
 */
async function openInsertMenu() {
	await editorToolbar().getByTestId('toolbar-insert-menu').click();
	await expect.element(page.getByRole('menu')).toBeInTheDocument();
}

async function codeModeRoundTrip() {
	// WYSIWYG -> code -> WYSIWYG is the contract the editor has to keep: the
	// markdown a node exports must re-import into the same markdown.
	await page.getByRole('button', { name: '切换到代码模式' }).click();
	await page.getByRole('button', { name: '切换到富文本模式' }).click();
}

describe('toolbar insert menu', () => {
	it('inserts a numbered footnote reference', async () => {
		const { screen } = await mountEditorFixture('前文');
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await body.click();
		const user = userEvent.setup();
		await user.keyboard('{End}');

		await openInsertMenu();
		await page.getByRole('menuitem', { name: '脚注引用' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('[^1]');

		// A second insert must not collide with the first label.
		await openInsertMenu();
		await page.getByRole('menuitem', { name: '脚注引用' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('[^2]');
	});

	it('inserts a details block', async () => {
		const { screen } = await mountEditorFixture('前文');
		await page.getByRole('textbox', { name: '输入正文...' }).click();

		await openInsertMenu();
		await page.getByRole('menuitem', { name: '折叠块' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain(':::details');
	});

	it('inserts a mermaid diagram whose source survives the code-mode round trip', async () => {
		const { screen } = await mountEditorFixture('前文');
		await page.getByRole('textbox', { name: '输入正文...' }).click();

		await openInsertMenu();
		await page.getByRole('menuitem', { name: 'Mermaid 图' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```mermaid');
		const before = readSaved(screen.container);

		await codeModeRoundTrip();
		await expect.poll(() => readSaved(screen.container), { timeout: 10_000 }).toBe(before);
	});

	it('asks for the handle and inserts a mention token', async () => {
		const { screen } = await mountEditorFixture('前文');
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await body.click();
		const user = userEvent.setup();
		await user.keyboard('{End}');

		await openInsertMenu();
		await page.getByRole('menuitem', { name: '提及' }).click();

		// The token is atomic (the caret cannot enter it), so the handle is
		// collected up front in a dialog rather than window.prompt.
		const input = page.getByTestId('value-prompt-input');
		await expect.element(input).toBeInTheDocument();
		await input.fill('@gh:octocat');
		await page.getByRole('button', { name: '确定' }).click();

		await expect.poll(() => readSaved(screen.container)).toContain('@gh:octocat');
	});
});

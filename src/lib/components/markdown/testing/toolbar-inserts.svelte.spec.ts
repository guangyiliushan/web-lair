import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import {
	editorToolbar,
	mountEditorFixture,
	mountEditorUnfocused,
	readSaved
} from './editor-spec-helpers';

// The code-block button opens the language picker since the dialog landed
// (its insert contract lives in toolbar-code-dialog.svelte.spec.ts); this spec
// keeps the direct-insert pathways.
describe('toolbar insert buttons', () => {
	it('inserts a link through the hover editor pane (prompt retired)', async () => {
		const { screen } = await mountEditorFixture('前文');
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await body.click();
		const user = userEvent.setup();
		await user.keyboard('{End}');
		await user.keyboard('{Shift>}{Home}{/Shift}');
		await editorToolbar().getByRole('button', { name: '链接' }).click();

		// 原位编辑浮层接管(批 3b:window.prompt 退役)
		const pane = () => document.querySelector('[aria-label="链接"]') as HTMLElement | null;
		await expect.poll(() => pane()?.querySelector('input') !== null, { timeout: 5000 }).toBe(true);
		const input = pane()!.querySelector('input') as HTMLInputElement;
		input.value = 'https://example.com';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const apply = [...(pane()!.querySelectorAll('button') ?? [])].find(
			(b) => b.textContent.trim() === '应用'
		);
		apply!.click();
		await expect.poll(() => readSaved(screen.container)).toContain('(https://example.com)');
	});

	it('inserts a tag', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '插入标签' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('<tag>');
	});

	it('inserts a divider', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '分割线' }).click();
		await expect.poll(() => readSaved(screen.container)).toMatch(/---/);
	});

	it('inserts the chosen alert type through the callout menu', async () => {
		const { screen } = await mountEditorFixture('前文');
		// the Callout button is a dropdown trigger: open it, then pick a type.
		// 警告 (warning) is deliberately NOT the default type, so a mutation
		// that always inserts the default would fail this assertion.
		await editorToolbar().getByRole('button', { name: 'Callout' }).click();
		await page.getByRole('menuitem', { name: '警告' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('[!WARNING]');
	});

	it('inserts an alert without any editor focus (root fallback)', async () => {
		// 949d7f4 contract: no range-selection guard — the nearest-root utility
		// appends at the document end when the editor was never focused.
		const { screen } = await mountEditorUnfocused('前文');
		await editorToolbar().getByRole('button', { name: 'Callout' }).click();
		await page.getByRole('menuitem', { name: '注意' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('[!CAUTION]');
	});
});

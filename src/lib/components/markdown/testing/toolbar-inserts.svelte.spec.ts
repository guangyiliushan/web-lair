import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
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
	it('inserts a link through the prompt', async () => {
		const { screen } = await mountEditorFixture('前文');
		const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com');
		try {
			await editorToolbar().getByRole('button', { name: '链接' }).click();
			await expect.poll(() => readSaved(screen.container)).toContain('(https://example.com)');
		} finally {
			prompt.mockRestore();
		}
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

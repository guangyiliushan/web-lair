import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ChainFixture from './editor-chain-fixture.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// Regression spec for the toolbar insert buttons: each one must actually
// land its construct in the document (serialised markdown is the observable).
function readSaved(container: Element): string {
	return container.querySelector('[data-latest-markdown]')?.textContent ?? '';
}

async function mountEditor(initial = '') {
	await page.viewport(1280, 800);
	const screen = await render(ChainFixture, { initialMarkdown: initial });
	const body = page.getByRole('textbox', { name: '输入正文...' });
	await expect.element(body).toBeInTheDocument();
	await body.click();
	return { screen, body };
}

const toolbar = () => page.getByRole('toolbar', { name: '编辑器工具栏' });

describe('toolbar insert buttons', () => {
	// The code-block button opens the language picker since the dialog landed
	// (its insert contract lives in toolbar-code-dialog.svelte.spec.ts); this
	// spec keeps the direct-insert pathways.

	it('inserts a link through the prompt', async () => {
		const { screen } = await mountEditor('前文');
		const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com');
		try {
			await toolbar().getByRole('button', { name: '链接' }).click();
			await expect.poll(() => readSaved(screen.container)).toContain('(https://example.com)');
		} finally {
			prompt.mockRestore();
		}
	});

	it('inserts a tag', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '插入标签' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('<tag>');
	});

	it('inserts a divider', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '分割线' }).click();
		await expect.poll(() => readSaved(screen.container)).toMatch(/---/);
	});

	it('inserts an alert through the callout menu', async () => {
		const { screen } = await mountEditor('前文');
		// the Callout button is a dropdown trigger: open it, then pick a type
		await toolbar().getByRole('button', { name: 'Callout' }).click();
		await page.getByRole('menuitem', { name: '备注' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('[!');
	});
});

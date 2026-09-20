import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ChainFixture from './editor-chain-fixture.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// The code-block button opens a language picker (search + select); the chosen
// language must land in the fence info string and round-trip through save.
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

describe('code block language picker', () => {
	it('opens the dialog, searches and inserts with the chosen language', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('tsx');
		await page.getByRole('option', { name: 'tsx' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```tsx');
	});

	it('offers the typed query as a custom language', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('brainfuck');
		await page.getByRole('option', { name: /brainfuck/ }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```brainfuck');
	});

	it('inserts a plain fence without a language', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('option', { name: '纯文本' }).click();
		await expect.poll(() => readSaved(screen.container)).toMatch(/```\n/);
	});

	it('sanitises free-form languages to a single info token', async () => {
		const { screen } = await mountEditor('前文');
		await toolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('a b`c');
		await page.getByRole('option', { name: /abc/ }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```abc');
	});
});

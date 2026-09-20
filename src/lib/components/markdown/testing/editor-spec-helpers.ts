import { page } from 'vitest/browser';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EditorChainFixture from './editor-chain-fixture.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
// Pin the UI locale inside the browser iframe (node-side setup cannot reach it).
overwriteGetLocale(() => 'zh-cn');

/** Serialised markdown as surfaced by the fixture after every change. */
export function readSaved(container: Element): string {
	return container.querySelector('[data-latest-markdown]')?.textContent ?? '';
}

/** The editor's top toolbar. */
export function editorToolbar() {
	return page.getByRole('toolbar', { name: '编辑器工具栏' });
}

/** Mounts the editor fixture at a wide viewport and focuses the editor. */
export async function mountEditorFixture(initial = '') {
	await page.viewport(1280, 800);
	const screen = await render(EditorChainFixture, { initialMarkdown: initial });
	const body = page.getByRole('textbox', { name: '输入正文...' });
	await expect.element(body).toBeInTheDocument();
	await body.click();
	return { screen, body };
}

/** Mounts the fixture without focusing the editor (root-fallback contracts). */
export async function mountEditorUnfocused(initial = '') {
	await page.viewport(1280, 800);
	const screen = await render(EditorChainFixture, { initialMarkdown: initial });
	await expect.element(page.getByRole('textbox', { name: '输入正文...' })).toBeInTheDocument();
	return { screen };
}

/** Reads the language picker's search box value. */
export async function searchBoxValue(): Promise<string> {
	const element = await page.getByRole('combobox').element();
	return (element as HTMLInputElement).value;
}

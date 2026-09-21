import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';

// Pin the UI locale: overwriteGetLocale runs in the browser iframe, unlike
// node-side setupFiles. Official escape hatch per paraglidejs.com/strategy.
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

describe('embed cards and mermaid in the editor DOM (batch C)', () => {
	it('renders a provider URL as an embed card', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '![sveltejs/svelte](https://github.com/sveltejs/svelte)',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-embed-host').length, { timeout: 15_000 })
			.toBeGreaterThan(0);
		await expect
			.poll(() => document.querySelector('.rich-editor-embed-host')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('GitHub');
	});

	it('renders a mermaid fence as a diagram', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '```mermaid\nflowchart LR\n\tA --> B\n```',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-mermaid-host .mermaid svg').length, {
				timeout: 20_000
			})
			.toBeGreaterThan(0);
	});
});

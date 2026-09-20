import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';
import { themeStore } from '$lib/stores/theme.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// Browser-project spec: the mermaid execution side (spec 3.3 / 7). The mount
// point (`pre.mermaid` with the raw source) comes from the pipeline on both
// sides; this layer upgrades it to a rendered SVG on the client, lazily.
const MERMAID = '```mermaid\ngraph TD;\n  A[甲] --> B[乙];\n```';

async function mountRenderer(source: string) {
	await page.viewport(1000, 800);
	const screen = await render(MarkdownRenderer, { source });
	return screen;
}

const svgIn = (container: Element) => container.querySelector('.mermaid svg');

describe('mermaid execution (client)', () => {
	it('upgrades the mount point to an SVG after the lazy load', async () => {
		const screen = await mountRenderer(MERMAID);
		await expect.poll(() => svgIn(screen.container) !== null, { timeout: 15_000 }).toBe(true);
	});

	it('keeps the raw source for re-rendering', async () => {
		const screen = await mountRenderer(MERMAID);
		await expect.poll(() => svgIn(screen.container) !== null, { timeout: 15_000 }).toBe(true);
		expect(screen.container.querySelector('.mermaid')?.getAttribute('data-md-source')).toContain(
			'graph TD'
		);
	});

	it('sanitises hostile labels under strict mode', async () => {
		const hostile = '```mermaid\ngraph TD;\n  A["<img src=x onerror=alert(1)>"] --> B;\n```';
		const screen = await mountRenderer(hostile);
		await expect.poll(() => svgIn(screen.container) !== null, { timeout: 15_000 }).toBe(true);
		expect(screen.container.querySelector('.mermaid svg img')).toBeNull();
		expect(screen.container.querySelector('.mermaid svg script')).toBeNull();
	});

	it('re-renders when the theme flips', async () => {
		const screen = await mountRenderer(MERMAID);
		await expect.poll(() => svgIn(screen.container) !== null, { timeout: 15_000 }).toBe(true);
		const before = svgIn(screen.container);
		themeStore.init();
		themeStore.value = 'dark';
		await expect
			.poll(() => document.documentElement.classList.contains('dark'), { timeout: 15_000 })
			.toBe(true);
		// a re-render replaces the SVG node: the old one carried the old palette
		await expect
			.poll(() => svgIn(screen.container) !== null && svgIn(screen.container) !== before, {
				timeout: 15_000
			})
			.toBe(true);
		themeStore.value = 'light';
	});
});

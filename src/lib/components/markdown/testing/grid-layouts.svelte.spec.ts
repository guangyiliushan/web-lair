import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// Browser-project spec: the grid layouts (spec 3.2 layout=masonry|carousel,
// 7: interactives carry ARIA and reduced-motion is respected). Everything is
// zero-JS: multi-column flow and scroll snap do the work, the mount layer
// only adds the static ARIA attributes.

const unmountFns: Array<() => void> = [];
afterEach(() => {
	while (unmountFns.length > 0) unmountFns.pop()!();
});

async function mountRenderer(source: string): Promise<HTMLElement> {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(MarkdownRenderer, { target: host, props: { source } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	unmountFns.push(() => unmount(instance));
	return host;
}

const gridOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.md-grid')!;
const styleOf = (element: Element) => getComputedStyle(element);

describe('grid layouts (spec 3.2 / 7)', () => {
	it('keeps the default layout on the grid variables (regression pin)', async () => {
		const host = await mountRenderer(':::grid{cols=2 gap=8}\n![](https://example.com/a.png)\n:::');
		const grid = gridOf(host);
		expect(styleOf(grid).gap).toBe('8px');
		expect(styleOf(grid).gridTemplateColumns.split(' ')).toHaveLength(2);
	});

	it('flows masonry through CSS columns with the requested count', async () => {
		const host = await mountRenderer(
			':::grid{cols=3 gap=8 layout=masonry}\n![](https://example.com/a.png)\n\n![](https://example.com/b.png)\n:::'
		);
		const grid = gridOf(host);
		expect(styleOf(grid).columnCount).toBe('3');
		expect(styleOf(grid).columnGap).toBe('8px');
		const item = grid.querySelector('p, img')!.closest('*')!;
		expect(styleOf(item).breakInside).toBe('avoid');
	});

	it('turns carousel into a snap-scrolling strip sized by cols', async () => {
		const host = await mountRenderer(
			':::grid{cols=3 gap=8 layout=carousel}\n![](https://example.com/a.png)\n\n![](https://example.com/b.png)\n:::'
		);
		const grid = gridOf(host);
		const style = styleOf(grid);
		expect(style.display).toBe('flex');
		expect(style.overflowX).toBe('auto');
		expect(style.scrollSnapType).toContain('x mandatory');
		expect(style.gap).toBe('8px');
		const items = Array.from(grid.children) as HTMLElement[];
		expect(items.length).toBeGreaterThan(0);
		expect(styleOf(items[0]).scrollSnapAlign).toBe('start');
		// cols=3: each card occupies roughly a third of the strip
		const ratio = items[0].getBoundingClientRect().width / grid.getBoundingClientRect().width;
		expect(ratio).toBeGreaterThan(0.25);
		expect(ratio).toBeLessThan(0.4);
	});

	it('a shorter closing fence does not close a deeper container', async () => {
		const host = await mountRenderer(':::details{summary="s"}\n甲\n::\n乙\n:::');
		const details = host.querySelector('details, .md-details');
		expect(details).not.toBeNull();
		expect(details!.textContent).toContain('甲');
		expect(details!.textContent).toContain('乙');
	});

	it('gives the carousel its ARIA surface from the mount layer', async () => {
		const host = await mountRenderer(
			':::grid{layout=carousel}\n![](https://example.com/a.png)\n:::'
		);
		const grid = gridOf(host);
		expect(grid.getAttribute('tabindex')).toBe('0');
		expect(grid.getAttribute('role')).toBe('region');
		expect(grid.getAttribute('aria-roledescription')).toBe('轮播');
		expect(grid.getAttribute('aria-label')).toBe('图片轮播');
	});

	it('leaves plain grids without the carousel surface', async () => {
		const host = await mountRenderer(':::grid{cols=2}\n![](https://example.com/a.png)\n:::');
		const grid = gridOf(host);
		expect(grid.getAttribute('role')).toBeNull();
		expect(grid.getAttribute('tabindex')).toBeNull();
	});
});

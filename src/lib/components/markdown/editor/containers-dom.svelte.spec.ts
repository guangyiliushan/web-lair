import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

describe('containers in the editor DOM (batch D)', () => {
	it('renders a details container with its summary and body', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: ':::details{summary="更多信息" open}\n详情内容\n:::',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-details-host').length, {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		await expect
			.poll(() => document.querySelector('.rich-editor-details-host')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('更多信息');
		await expect
			.poll(() => document.querySelector('.rich-editor-details-host')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('详情内容');
	});

	it('keeps the container mounted across an undo (freeze fix)', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: ':::details{summary="更多信息" open}\n详情内容\n:::',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-details-host').length, {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await body.click();
		await userEvent.keyboard('{End}TAIL');
		await userEvent.keyboard('{Control>}z{/Control}');
		await new Promise((r) => setTimeout(r, 600));
		// the decorator handle lives in a WeakMap: undo must not throw and
		// the host must survive
		expect(document.querySelectorAll('.rich-editor-details-host').length).toBeGreaterThan(0);
	});

	it('keeps typing after the debounced write remounts the decorator (batch D fix)', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: ':::details{summary="更多信息" open}\n详情内容\n:::',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-details-host').length, {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		const host = document.querySelector('.rich-editor-details-host') as HTMLElement;
		const inner = host.querySelector('[role="textbox"]') as HTMLElement;
		inner.focus();
		await userEvent.keyboard('AAA');
		await new Promise((r) => setTimeout(r, 900)); // let the 400ms debounce write land
		// the write dirties the node and the decorator remounts: the focus
		// memory must hand focus to the new content root
		const hostAfter = document.querySelector('.rich-editor-details-host') as HTMLElement;
		expect(hostAfter.contains(document.activeElement)).toBe(true);
		// click into the (remounted) body and keep typing: the body must still work
		const innerAfter = hostAfter.querySelector('[role="textbox"]') as HTMLElement;
		await userEvent.click(innerAfter);
		await userEvent.keyboard('BBB');
		await new Promise((r) => setTimeout(r, 300));
		expect(hostAfter.textContent).toContain('AAA');
		expect(hostAfter.textContent).toContain('BBB');
	});

	it('renders a tabs container with both labels', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown:
				'::::tabs\n:::tab{label="第一个标签"}\n第一页内容。\n:::\n:::tab{label="第二个标签"}\n第二页内容。\n:::\n::::',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-tabs-host [role="tab"]').length, {
				timeout: 15_000
			})
			.toBe(2);
		await expect
			.poll(() => document.querySelector('.rich-editor-tabs-host')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('第一页内容');
	});

	it('renders a grid container with its layout variables', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown:
				':::grid{cols=2 gap=8 layout=grid type=images}\n![图一](https://example.com/a.png)\n![图二](https://example.com/b.png)\n:::',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-grid-host .rich-editor-grid').length, {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		const grid = document.querySelector('.rich-editor-grid') as HTMLElement;
		expect(grid.getAttribute('data-layout')).toBe('grid');
		expect(grid.getAttribute('style')).toContain('--grid-cols: 2');
	});
});

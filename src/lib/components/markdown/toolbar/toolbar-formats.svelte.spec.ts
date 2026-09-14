import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from './ToolbarTestHost.svelte';

// Regression: top toolbar format buttons lost the editor selection and did
// nothing, while the floating toolbar applied the same format correctly.
describe('editor toolbar character formats', () => {
	it('applies bold via the top toolbar to the current selection', async () => {
		await render(ToolbarTestHost, {
			initialMarkdown: 'hello world',
			placeholder: '输入正文...'
		});

		const user = userEvent.setup();
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await expect.element(body).toBeInTheDocument();

		await body.click();
		await user.keyboard('{End}');
		await user.keyboard('{Shift>}{Home}{/Shift}');
		// 限定顶部工具栏(选区存在时浮动工具栏也会出现同名按钮)
		await page
			.getByRole('toolbar', { name: '编辑器工具栏' })
			.getByRole('button', { name: '粗体' })
			.click();

		// 选区文本被包裹为 strong
		await expect.element(page.getByRole('strong')).toHaveTextContent('hello world');
	});

	// Regression: inserting a Callout while the caret was inside a table
	// nested it into a table cell and broke the table layout.
	describe('block inserts inside tables', () => {
		it('disables block inserts and keeps inline inserts available', async () => {
			await render(ToolbarTestHost, {
				initialMarkdown: '',
				placeholder: '输入正文...'
			});

			const user = userEvent.setup();
			const body = page.getByRole('textbox', { name: '输入正文...' });
			await expect.element(body).toBeInTheDocument();
			const toolbar = page.getByRole('toolbar', { name: '编辑器工具栏' });

			// 先聚焦获得光标,插入命令才有落点
			await body.click();
			await toolbar.getByRole('button', { name: '插入表格' }).click();
			await expect.element(page.getByRole('table')).toBeInTheDocument();

			// 块级插入禁用
			await expect.element(toolbar.getByRole('button', { name: '插入图片' })).toBeDisabled();
			await expect.element(toolbar.getByRole('button', { name: '分割线' })).toBeDisabled();
			await expect.element(toolbar.getByRole('button', { name: 'Callout' })).toBeDisabled();
			await expect.element(toolbar.getByRole('button', { name: '代码块' })).toBeDisabled();
			// 行内插入保持可用
			await expect.element(toolbar.getByRole('button', { name: '插入标签' })).toBeEnabled();
		});
	});

	// Regression: the overflow ("更多") menu must stay inside the viewport on
	// small or short screens and scroll within itself instead of the page.
	describe('overflow menu responsiveness', () => {
		// Note: only static viewports are covered here. After a dynamic
		// page.viewport() resize inside the vitest iframe, bits-ui does not
		// recompute its floating available-height, so resized cases (e.g.
		// 500x500, 700x360) are covered by GUI measurement instead.
		const cases: Array<[number, number, boolean]> = [
			// [width, height, menu expected to exist]
			[425, 700, true],
			[1280, 720, false]
		];

		for (const [width, height, menuExpected] of cases) {
			it(`behaves correctly at ${width}x${height}`, async () => {
				await page.viewport(width, height);
				await render(ToolbarTestHost, {
					initialMarkdown: '内容',
					placeholder: '输入正文...'
				});

				const toolbar = page.getByRole('toolbar', { name: '编辑器工具栏' });
				await expect.element(toolbar).toBeInTheDocument();

				const moreBtn = toolbar.getByRole('button', { name: '更多' });
				if (!menuExpected) {
					// 大屏所有按钮平铺,不应出现溢出菜单
					await expect.element(moreBtn).not.toBeInTheDocument();
					return;
				}

				// Pointer position persists across tests; a stale hover makes the
				// tooltip open instantly over the button. Reset, then click.
				await userEvent.unhover(document.body);
				await userEvent.click(moreBtn);
				const menu = page.getByRole('menu');
				await expect.element(menu).toBeInTheDocument();

				const menuEl = await menu.element();
				const r = menuEl.getBoundingClientRect();
				const box = {
					top: r.top,
					bottom: r.bottom,
					left: r.left,
					right: r.right,
					overflowY: getComputedStyle(menuEl).overflowY
				};
				// 菜单完整落在视口内
				expect(box.top).toBeGreaterThanOrEqual(0);
				expect(box.bottom).toBeLessThanOrEqual(height);
				expect(box.left).toBeGreaterThanOrEqual(0);
				expect(box.right).toBeLessThanOrEqual(width);
				// 放不下时组件内滚动(而非撑破页面);放得下时保持 visible 即可
				const scrollsInternally = menuEl.scrollHeight > menuEl.clientHeight + 1;
				if (scrollsInternally) {
					expect(box.overflowY).toBe('auto');
				}
			});
		}
	});
});

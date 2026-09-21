import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';

// Pin the UI locale: overwriteGetLocale runs in the browser iframe, unlike
// node-side setupFiles. Official escape hatch per paraglidejs.com/strategy.
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

describe('math and footnote editing (batch B)', () => {
	it('renders inline math with KaTeX and opens the edit dialog on click', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '结果 $E = mc^2$ 结束',
			placeholder: '输入正文...'
		});

		// KaTeX is imported lazily by the decorator — poll for the rendered span.
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-math .katex').length, { timeout: 15_000 })
			.toBeGreaterThan(0);

		const inner = document.querySelector('.rich-editor-math-inner') as HTMLElement;
		expect(inner).toBeTruthy();
		await userEvent.click(inner);

		// the dialog shows the current LaTeX source
		const latexBox = document.querySelector('#math-latex') as HTMLTextAreaElement;
		expect(latexBox).toBeTruthy();
		expect(latexBox.value).toBe('E = mc^2');

		// edit and save: the node re-renders with the new source
		latexBox.value = 'a^2 + b^2';
		latexBox.dispatchEvent(new Event('input', { bubbles: true }));
		await page.getByRole('button', { name: '保存' }).click();
		await expect
			.poll(() => document.querySelector('.rich-editor-math .katex')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('b');
	});

	it('renders block math in display mode', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '正文\n\n$$x^2$$\n\n正文之后',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-math-block .katex').length, {
				timeout: 15_000
			})
			.toBeGreaterThan(0);
	});

	it('renders footnote refs and inline footnotes as chips', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '正文[^note] 与 ^[行内脚注] 之后\n\n[^note]: 定义文本',
			placeholder: '输入正文...'
		});
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-footnote-ref').length)
			.toBeGreaterThan(0);
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-footnote-inline').length)
			.toBeGreaterThan(0);
		// the definition line stays literal source text (registered follow-up)
		const body = document.querySelector('[role="textbox"]')?.textContent ?? '';
		expect(body).toContain('[^note]: 定义文本');
	});
	it('converts typed math syntax live (trigger path)', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '',
			placeholder: '输入正文...'
		});
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await expect.element(body).toBeInTheDocument();
		await body.click();
		await userEvent.keyboard('$x$');
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-math').length, { timeout: 15_000 })
			.toBeGreaterThan(0);
	});

	it('keeps the document across the code-mode round trip (batch B fix)', async () => {
		await page.viewport(1280, 720);
		await render(ToolbarTestHost, {
			initialMarkdown: '前 $x$ 后',
			placeholder: '输入正文...'
		});
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await expect.element(body).toBeInTheDocument();
		await body.click();
		await userEvent.keyboard('{End}ZZ');
		await page.getByRole('button', { name: '切换到代码模式' }).click();
		const ta = document.querySelector('textarea') as HTMLTextAreaElement;
		expect(ta).toBeTruthy();
		expect(ta.value).toContain('ZZ');
		ta.value = ta.value + 'YY';
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		await page.getByRole('button', { name: '切换到富文本模式' }).click();
		await expect
			.poll(() => document.querySelector('[role="textbox"]')?.textContent ?? '', {
				timeout: 10_000
			})
			.toContain('YY');
		expect(document.querySelector('[role="textbox"]')?.textContent ?? '').toContain('ZZ');
	});
});

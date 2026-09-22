import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/**
 * LinkHoverEditor (batch 3b): in-place link editing in the rich editor —
 * caret-in-link opens the view pane, the pane edits/removes without losing
 * the editor selection, and the toolbar link button opens the create flow
 * (the retired window.prompt path).
 */

const LINK_MD = '前缀 [示例链接](https://example.com/old) 后缀';

/** 浮层节点每次现查:编辑态切换会重渲染,旧引用失效。 */
const pane = () => document.querySelector('[aria-label="链接"]') as HTMLElement | null;

async function mountHost(md = LINK_MD) {
	await page.viewport(1280, 720);
	await render(ToolbarTestHost, { initialMarkdown: md, placeholder: '输入正文...' });
	await expect
		.poll(() => document.querySelectorAll('[role="textbox"]').length, { timeout: 5000 })
		.toBeGreaterThan(0);
}

async function caretIntoLink() {
	const link = document.querySelector('[role="textbox"] a') as HTMLAnchorElement;
	const rect = link.getBoundingClientRect();
	await page
		.getByText('示例链接')
		.click({ position: { x: Math.max(8, rect.width / 2), y: rect.height / 2 } });
}

async function openViewPane() {
	await caretIntoLink();
	await expect.poll(() => pane() !== null, { timeout: 5000 }).toBe(true);
}

function setInputValue(value: string) {
	const input = pane()?.querySelector('input') as HTMLInputElement | null;
	if (!input) throw new Error('edit input not mounted');
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickPaneButton(label: string) {
	const btn = pane()?.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
	if (!btn) throw new Error(`pane button ${label} not mounted`);
	btn.click();
}

function clickApply() {
	const btn = [...(pane()?.querySelectorAll('button') ?? [])].find(
		(b) => b.textContent.trim() === '应用'
	);
	if (!btn) throw new Error('apply button not mounted');
	btn.click();
}

const linkHref = () =>
	(document.querySelector('[role="textbox"] a') as HTMLAnchorElement | null)?.getAttribute('href');

describe('link hover editor', () => {
	it('opens the view pane when the caret lands inside a link', async () => {
		await mountHost();
		await expect
			.poll(() => document.querySelectorAll('[role="textbox"] a').length, { timeout: 5000 })
			.toBeGreaterThan(0);
		await openViewPane();
		expect(pane()!.textContent).toContain('https://example.com/old');
	});

	it('applies an edited URL to the link node', async () => {
		await mountHost();
		await expect
			.poll(() => document.querySelectorAll('[role="textbox"] a').length, { timeout: 5000 })
			.toBeGreaterThan(0);
		await openViewPane();
		clickPaneButton('编辑链接');
		await expect.poll(() => pane()?.querySelector('input') !== null, { timeout: 5000 }).toBe(true);
		setInputValue('https://example.com/new');
		await new Promise((r) => setTimeout(r, 100));
		clickApply();
		await expect.poll(() => linkHref(), { timeout: 5000 }).toBe('https://example.com/new');
	});

	it('removes the link but keeps the text', async () => {
		await mountHost();
		await expect
			.poll(() => document.querySelectorAll('[role="textbox"] a').length, { timeout: 5000 })
			.toBeGreaterThan(0);
		await openViewPane();
		clickPaneButton('移除链接');
		await expect
			.poll(() => document.querySelectorAll('[role="textbox"] a').length, { timeout: 5000 })
			.toBe(0);
		expect(document.querySelector('[role="textbox"]')?.textContent ?? '').toContain('示例链接');
	});

	it('creates a link from a selection via the toolbar (prompt retired)', async () => {
		await mountHost('裸文本内容');
		const body = page.getByRole('textbox', { name: '输入正文...' });
		await body.click();
		const user = userEvent.setup();
		await user.keyboard('{End}');
		await user.keyboard('{Shift>}{Home}{/Shift}');

		await page
			.getByRole('toolbar', { name: '编辑器工具栏' })
			.getByRole('button', { name: '插入链接' })
			.click();

		await expect.poll(() => pane()?.querySelector('input') !== null, { timeout: 5000 }).toBe(true);
		setInputValue('https://svelte.dev');
		await new Promise((r) => setTimeout(r, 100));
		clickApply();
		await expect.poll(() => linkHref(), { timeout: 5000 }).toBe('https://svelte.dev');
	});

	it('escape in edit mode returns to view when a link exists', async () => {
		await mountHost();
		await expect
			.poll(() => document.querySelectorAll('[role="textbox"] a').length, { timeout: 5000 })
			.toBeGreaterThan(0);
		await openViewPane();
		clickPaneButton('编辑链接');
		await expect.poll(() => pane()?.querySelector('input') !== null, { timeout: 5000 }).toBe(true);
		const input = pane()?.querySelector('input') as HTMLInputElement;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		// 回到查看态:浮层仍在且显示 URL 文本(而非输入框)
		expect(pane()?.textContent).toContain('https://example.com/old');
		expect(pane()?.querySelector('input')).toBeNull();
	});
});

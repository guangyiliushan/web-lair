import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';

// Pin the UI locale: overwriteGetLocale runs in the browser iframe, unlike
// node-side setupFiles. Official escape hatch per paraglidejs.com/strategy.
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/** Sample document covering every v0.3 syntax in EDITOR_TRANSFORMERS plus the ordinary
 * blocks */
const SYNTAX_DOC = [
	'# 编辑器可视化测试',
	'',
	'## 新语法集合',
	'',
	'段落含 **加粗**、*斜体*、~~删除线~~、`行内代码` 与 [链接](https://example.com)。',
	'',
	'剧透:||这里是被隐藏的剧透内容||,高亮:==重点标记文本==,标签:<tag>测试标签</tag>。',
	'',
	'提及:@gh:someone、@tw:another、@tg:channel。',
	'',
	'上标 E=mc<sup>2</sup>,下标 H<sub>2</sub>O。',
	'',
	'> [!NOTE] 提示标题',
	'> NOTE 告警正文,内含 **加粗**。',
	'',
	'> [!WARNING] 警告标题',
	'> WARNING 告警正文。',
	'',
	'## 常规块',
	'',
	'> 普通引用块内容',
	'',
	'- 无序列表项一',
	'- 无序列表项二',
	'',
	'1. 有序列表项一',
	'2. 有序列表项二',
	'',
	'| 语法 | 标记 | 状态 |',
	'| --- | --- | --- |',
	'| 剧透 | spoiler | 已支持 |',
	'| 高亮 | mark | 已支持 |',
	'| 提及 | mention | 已支持 |',
	'',
	'---',
	'',
	"![示意图](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='320'%20height='120'%3E%3Crect%20width='100%25'%20height='100%25'%20fill='%236c7bd4'/%3E%3Ctext%20x='50%25'%20y='55%25'%20fill='white'%20text-anchor='middle'%20font-size='20'%20font-family='sans-serif'%3EIMAGE%20320x120%3C/text%3E%3C/svg%3E)",
	'',
	'```ts',
	"const editor = 'Lexical';",
	'export function mount(): string {',
	'\treturn editor;',
	'}',
	'```'
].join('\n');

/** Deepest node to wait on so the whole document has imported (the alert decorator
 * is the last Svelte subtree to mount) */
async function waitForImport() {
	await expect
		.poll(() => document.querySelectorAll('.rich-editor-alert-host').length)
		.toBeGreaterThanOrEqual(2);
	await expect.poll(() => document.querySelectorAll('.spoiler').length).toBeGreaterThanOrEqual(1);
}

/** innerText of the editor's root textbox (nested alert editor content included) */
async function editorInnerText(): Promise<string> {
	// findElement waits for the node (element() is the synchronous escape hatch)
	const el = await page
		.getByRole('textbox', { name: '输入正文...' })
		.findElement({ timeout: 15_000 });
	return el.textContent ?? '';
}

/** Screenshot matrix from large to small: phone / foldable / tablet / laptop /
 * desktop / ultrawide */
const SHOT_MATRIX: Array<{ w: number; h: number; label: string }> = [
	{ w: 2560, h: 1200, label: 'ultrawide-desktop' },
	{ w: 1920, h: 1080, label: 'desktop-fhd' },
	{ w: 1536, h: 960, label: 'desktop-2xl' },
	{ w: 1280, h: 800, label: 'laptop-macbook-air' },
	{ w: 1180, h: 820, label: 'tablet-ipad-landscape' },
	{ w: 1024, h: 768, label: 'tablet-lg-boundary' },
	{ w: 834, h: 1194, label: 'tablet-ipad-pro-portrait' },
	{ w: 806, h: 771, label: 'fold-zfold5-inner' },
	{ w: 768, h: 1024, label: 'tablet-ipad-mini-portrait' },
	{ w: 692, h: 717, label: 'fold-pixel-inner' },
	{ w: 430, h: 932, label: 'phone-promax' },
	{ w: 375, h: 812, label: 'phone-standard' },
	{ w: 360, h: 780, label: 'phone-android' },
	{ w: 344, h: 882, label: 'fold-cover-display' },
	{ w: 320, h: 568, label: 'phone-se-smallest' }
];

/**
 * Visual test: WYSIWYG rendering of the full v0.3 syntax set, plus full-size screenshots.
 *
 * Complements editor-viewport-matrix.svelte.spec.ts (layout invariants on empty
 * content): the public MarkdownEditor mounted through ToolbarTestHost in real Chromium
 * with the real layout.css, driven through the initialMarkdown prop (markdown ->
 * editor DOM) and the code-mode toggle (round-trip fidelity).
 *
 * Screenshots land outside the repo at ../../../../../../editor-visual-shots/
 * (screenshots never enter git); light theme only.
 * Mention tokens are exempt from the no-literal-markdown scan (asserted in the first
 * case).
 */
describe('editor WYSIWYG visual (v0.3 syntax set)', () => {
	it('imports every v0.3 syntax as styled nodes, no literal markdown left', async () => {
		await page.viewport(1280, 800);
		await render(ToolbarTestHost, { initialMarkdown: SYNTAX_DOC, placeholder: '输入正文...' });
		await waitForImport();

		// ── New syntax: spoiler / mark / mention / tag ──
		await expect
			.poll(() => document.querySelector('.spoiler')?.textContent)
			.toBe('这里是被隐藏的剧透内容');
		// Lexical renders highlight as a <mark> wrapper with the theme class on an inner span
		await expect
			.poll(() => document.querySelector('.rich-editor-highlight')?.textContent)
			.toBe('重点标记文本');
		expect(document.querySelector('mark')?.textContent).toBe('重点标记文本');
		const mentions = () => [...document.querySelectorAll('.mention')].map((n) => n.textContent);
		await expect.poll(() => mentions().join('|')).toBe('@gh:someone|@tw:another|@tg:channel');
		await expect
			.poll(() => document.querySelector('.rich-editor-tag')?.textContent)
			.toBe('测试标签');

		// ── New syntax: alerts (decorator + type variants) ──
		expect(document.querySelectorAll('.rich-editor-alert.rich-editor-alert-note').length).toBe(1);
		expect(document.querySelectorAll('.rich-editor-alert.rich-editor-alert-warning').length).toBe(
			1
		);

		// ── New syntax: sup / sub ──
		expect(document.querySelector('sup')?.textContent).toBe('2');
		expect(document.querySelector('sub')?.textContent).toBe('2');

		// ── Ordinary blocks: heading / inline formats / link / quote / list / table / HR /
		// image / code block ──
		expect(document.querySelectorAll('.rich-editor-h1').length).toBe(1);
		expect(document.querySelectorAll('.rich-editor-h2').length).toBe(2);
		expect(document.querySelector('.rich-editor-bold')?.textContent).toBe('加粗');
		expect(document.querySelector('.rich-editor-italic')?.textContent).toBe('斜体');
		expect(document.querySelector('.rich-editor-strikethrough')?.textContent).toBe('删除线');
		expect(document.querySelector('.rich-editor-inline-code')?.textContent).toBe('行内代码');
		expect(document.querySelector('a[href="https://example.com"]')?.textContent).toBe('链接');
		expect(document.querySelectorAll('.rich-editor-quote').length).toBe(1);
		expect(document.querySelectorAll('.rich-editor-ul .rich-editor-li').length).toBe(2);
		expect(document.querySelectorAll('.rich-editor-ol .rich-editor-li').length).toBe(2);
		expect(document.querySelectorAll('.rich-editor-table').length).toBe(1);
		expect(document.querySelectorAll('.rich-editor-table-cell-header').length).toBe(3);
		expect(document.querySelectorAll('hr').length).toBe(1);
		expect(document.querySelector('figure img')?.getAttribute('alt')).toBe('示意图');
		expect(document.querySelector('.rich-editor-code-block')?.textContent).toContain('Lexical');

		// ── WYSIWYG: the body must not retain literal markdown delimiters ──
		// (mention tokens keep their source text by design and are not part of this check)
		const text = await editorInnerText();
		for (const literal of [
			'||',
			'==',
			'<tag>',
			'</tag>',
			'<sup>',
			'</sup>',
			'<sub>',
			'</sub>',
			'**',
			'~~',
			'```',
			'[!NOTE]',
			'[!WARNING]'
		]) {
			expect(text, `literal markdown ${literal} leaked into the editor`).not.toContain(literal);
		}
	});

	it('code mode keeps the markdown source and restores rich rendering (round-trip)', async () => {
		await page.viewport(1280, 800);
		await render(ToolbarTestHost, { initialMarkdown: SYNTAX_DOC, placeholder: '输入正文...' });
		await waitForImport();

		// Enter code mode: the exported markdown source must keep every syntax delimiter
		await page.getByRole('button', { name: '切换到代码模式' }).click();
		// findElement waits for the element to appear (4.1+); element() is the synchronous
		// escape hatch and throws when nothing matches
		const textarea = (await page
			.getByRole('textbox', { name: '输入正文...' })
			.findElement({ timeout: 15_000 })) as HTMLTextAreaElement;
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement); // pins the `as` assertion
		const src = textarea.value;
		for (const expected of [
			'||这里是被隐藏的剧透内容||',
			'==重点标记文本==',
			'<tag>测试标签</tag>',
			'@gh:someone',
			'@tw:another',
			'@tg:channel',
			'E=mc<sup>2</sup>',
			'H<sub>2</sub>O',
			'> [!NOTE] 提示标题',
			'> [!WARNING] 警告标题',
			'| 语法 | 标记 | 状态 |',
			'---',
			'![示意图](data:',
			'```ts'
		]) {
			expect(src, `code mode lost markdown syntax: ${expected}`).toContain(expected);
		}

		// Back to rich text: re-rendered, still no literal markdown left over
		await page.getByRole('button', { name: '切换到富文本模式' }).click();
		await waitForImport();
		const text = await editorInnerText();
		expect(text).toContain('这里是被隐藏的剧透内容');
		expect(text).not.toContain('||');
		expect(text).not.toContain('<tag>');
	});

	for (const { w, h, label } of SHOT_MATRIX) {
		it(`renders the full syntax document at ${w}x${h} (${label})`, async () => {
			await page.viewport(w, h);
			await render(ToolbarTestHost, { initialMarkdown: SYNTAX_DOC, placeholder: '输入正文...' });
			await waitForImport();

			// No horizontal overflow with real content either (empty content is covered by
			// viewport-matrix)
			const de = document.documentElement;
			expect(
				de.scrollWidth <= de.clientWidth + 1,
				`horizontal overflow with rich content at ${w}x${h}`
			).toBe(true);

			// Screenshot: editor-visual-shots/ outside the repo, named by size
			await page.screenshot({
				path: `../../../../../../editor-visual-shots/${label}-${w}x${h}.png`
			});
		});
	}
});

import { describe, expect, it, afterEach } from 'vitest';
import { renderMarkdownToHtmlSync } from '../editor/markdown-config';

// Pin the UI locale: overwriteGetLocale runs in the browser iframe, unlike
// node-side setupFiles. Official escape hatch per paraglidejs.com/strategy.
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/**
 * Visual regression for the markdown syntax surface (spec v0.3 migration).
 *
 * Runs the light pipeline (same one as the editor preview), injects the
 * produced HTML into the live document — the tester harness loads the app
 * global CSS (vitest-tester.html) — then asserts the *painted* result via
 * getComputedStyle / DOM shape, so a broken element/CSS contract fails here
 * even when the HTML string assertions in conformance-cases still pass.
 *
 * Standard-markdown checks mount inside the app's typography wrapper
 * (`prose`, the class MarkdownRenderer applies when its prose prop is on).
 * Batch-2-in-flight syntax (mention) is intentionally covered — a red there
 * documents current state.
 */

let host: HTMLElement | undefined;

function mountHtml(html: string): HTMLElement {
	host?.remove();
	host = document.createElement('div');
	host.id = 'markdown-visual-host';
	document.body.appendChild(host);
	host.innerHTML = html;
	return host;
}

/** Renders md and mounts it inside the app's typography context. */
function mountMarkdown(md: string): HTMLElement {
	return mountHtml(`<div class="prose max-w-none">${renderMarkdownToHtmlSync(md)}</div>`);
}

afterEach(() => {
	host?.remove();
	host = undefined;
});

describe('markdown rendered output paints correctly', () => {
	it('==mark== paints as a highlight element', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('高亮 ==重点== 结束'));
		const mark = root.querySelector('mark');
		expect(mark, '==重点== must produce <mark>重点</mark>').not.toBeNull();
		expect(mark!.textContent).toBe('重点');
		// Chromium UA default for <mark> — proves the element actually paints
		// as a highlight rather than being sanitized away or left transparent
		expect(getComputedStyle(mark!).backgroundColor).toBe('rgb(255, 255, 0)');
	});

	it('||spoiler|| paints with the app spoiler filter', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('剧透 ||隐藏内容|| 结束'));
		const spoiler = root.querySelector('span.spoiler');
		expect(spoiler, '||隐藏内容|| must produce span.spoiler').not.toBeNull();
		expect(spoiler!.textContent).toBe('隐藏内容');
		// layout.css: .spoiler { filter: invert(25%) }, hover restores — the
		// spoiler must start obscured and become readable only on hover
		// (Chrome serializes the percentage as a 0..1 factor)
		expect(getComputedStyle(spoiler!).filter).toBe('invert(0.25)');
	});

	it('==*emphasis*== keeps nested structure and paints both effects', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('==*斜体加亮*=='));
		const em = root.querySelector('mark > em');
		expect(em, '斜体加亮 must be <mark><em>…</em></mark>').not.toBeNull();
		expect(getComputedStyle(em!).fontStyle).toBe('italic');
		expect(getComputedStyle(em!.closest('mark')!).backgroundColor).toBe('rgb(255, 255, 0)');
	});

	it('inline math paints as KaTeX', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('质能方程 $E=mc^2$ 成立'));
		const katex = root.querySelector('.katex');
		expect(katex, '$E=mc^2$ must render as KaTeX markup').not.toBeNull();
		// KaTeX ships its own font family — proves the stylesheet side of math
		expect(getComputedStyle(katex!).fontFamily).toContain('KaTeX');
	});

	it('dollar amounts stay literal (math guard) — nothing math-painted', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('价格 $5,成本 $3 均为字面'));
		expect(root.querySelectorAll('.katex')).toHaveLength(0);
		expect(root.textContent).toContain('$5');
		expect(root.textContent).toContain('$3');
	});

	it('mark is allowed inside table cells; escaped || stays literal there', () => {
		// header row (th) + body row (td): mark must survive in both
		const root = mountHtml(renderMarkdownToHtmlSync('| a | ==b== |\n| --- | --- |\n| c | ==d== |'));
		const thMark = root.querySelector('th mark');
		expect(thMark, '==b== must survive as <mark> inside the header cell').not.toBeNull();
		const tdMark = root.querySelector('td mark');
		expect(tdMark, '==d== must survive as <mark> inside the body cell').not.toBeNull();
		expect(getComputedStyle(tdMark!).backgroundColor).toBe('rgb(255, 255, 0)');

		const escaped = mountHtml(
			renderMarkdownToHtmlSync('| a | x \\|\\|剧透\\|\\| y |\n| --- | --- |')
		);
		expect(
			escaped.querySelector('span.spoiler'),
			'escaped || must not become a spoiler'
		).toBeNull();
		expect(escaped.textContent).toContain('||剧透||');
	});
});

describe('standard markdown (L0/L1) paints', () => {
	it('headings, emphasis, strikethrough and links render', () => {
		const root = mountMarkdown(
			'# 标题一\n\n**粗体** *斜体* ~~删除线~~ [链接](https://example.com)'
		);
		const h1 = root.querySelector('h1');
		expect(h1, '# heading must render').not.toBeNull();
		// typography wrapper: h1 must be painted larger than body text
		expect(parseFloat(getComputedStyle(h1!).fontSize)).toBeGreaterThan(20);
		expect(getComputedStyle(root.querySelector('strong')!).fontWeight).toMatch(/^(bold|[6-9]00)$/);
		expect(getComputedStyle(root.querySelector('em')!).fontStyle).toBe('italic');
		expect(getComputedStyle(root.querySelector('del')!).textDecorationLine).toContain(
			'line-through'
		);
		const a = root.querySelector('a:not(.md-anchor)')!;
		expect(a.getAttribute('href')).toBe('https://example.com');
		expect(a.textContent).toBe('链接');
	});

	it('blockquote, lists, task list and hr render', () => {
		const root = mountMarkdown(
			'> 引用行\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n- [x] 完成项\n- [ ] 未完成\n\n---'
		);
		expect(root.querySelector('blockquote')?.textContent).toContain('引用行');
		expect(root.querySelectorAll('ul > li').length).toBeGreaterThanOrEqual(3);
		expect(root.querySelectorAll('ol > li')).toHaveLength(2);
		const boxes = root.querySelectorAll('input[type="checkbox"]');
		expect(boxes).toHaveLength(2);
		expect((boxes[0] as HTMLInputElement).checked).toBe(true);
		expect((boxes[1] as HTMLInputElement).checked).toBe(false);
		const hr = root.querySelector('hr');
		expect(hr).not.toBeNull();
		expect(getComputedStyle(hr!).borderTopStyle).not.toBe('none');
	});

	it('tables, inline code and fenced code render', () => {
		const root = mountMarkdown(
			'| 左 | 右 |\n| :-- | --: |\n| a | b |\n\n行内 `code` 文本\n\n```\nconst x = 1\n```'
		);
		expect(root.querySelectorAll('table th')).toHaveLength(2);
		expect(root.querySelectorAll('table td')).toHaveLength(2);
		const inlineCode = root.querySelector('p code');
		expect(inlineCode?.textContent).toBe('code');
		expect(getComputedStyle(inlineCode!).fontFamily.toLowerCase()).toContain('mono');
		const pre = root.querySelector('pre code');
		expect(pre?.textContent).toContain('const x = 1');
	});

	it('footnote and image render', () => {
		const root = mountMarkdown('正文[^1]\n\n[^1]: 脚注内容');
		expect(root.querySelector('sup')).not.toBeNull();
		expect(root.textContent).toContain('脚注内容');

		const imgRoot = mountMarkdown('![替代文本](https://example.com/pic.png)');
		const el = imgRoot.querySelector('img');
		expect(el?.getAttribute('src')).toBe('https://example.com/pic.png');
		expect(el?.getAttribute('alt')).toBe('替代文本');
	});
});

describe('custom extensions (L2 migration state) paint', () => {
	it('display math renders as katex-display', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('$$\n\\int_0^1 x\\,dx\n$$'));
		expect(root.querySelector('.katex-display')).not.toBeNull();
	});

	it('mention renders as a token link (batch 2 — currently in flight)', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('找 @gh:octocat 看看'));
		const a = root.querySelector('a');
		expect(a, '@gh:octocat must become a token link').not.toBeNull();
		expect(a!.getAttribute('href')).toBe('@gh:octocat');
		expect(a!.textContent).toBe('@gh:octocat');
	});

	it('retired #x# syntax stays literal (batch 2 retirement)', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('标记 #tag# 结束'));
		expect(root.querySelector('.tag')).toBeNull();
		expect(root.textContent).toContain('#tag#');
	});

	it('raw HTML whitelist: kbd/tag/details paint, script/img stripped', () => {
		const root = mountHtml(
			renderMarkdownToHtmlSync(
				'按 <kbd>Ctrl</kbd> 与 <tag>标签</tag>\n\n<details open><summary>摘要</summary>细节</details>'
			)
		);
		const kbd = root.querySelector('kbd');
		expect(kbd?.textContent).toBe('Ctrl');
		expect(getComputedStyle(kbd!).fontFamily.toLowerCase()).toContain('mono');
		const tagEl = root.querySelector('tag');
		expect(tagEl?.textContent).toBe('标签');
		// layout.css styles the element itself (`tag { … }`, spec 4.5): the pill
		// must actually paint, not just exist in the DOM
		expect(getComputedStyle(tagEl!).display).toBe('inline-block');
		const det = root.querySelector('details');
		expect(det).not.toBeNull();
		expect(det!.hasAttribute('open')).toBe(true);
		expect(det!.querySelector('summary')?.textContent).toBe('摘要');
		expect(det!.textContent).toContain('细节');

		const bad = mountHtml(
			renderMarkdownToHtmlSync(
				'<script>alert(1)</script><img src="https://evil.example/x.png" onerror="alert(1)"> 安全'
			)
		);
		expect(bad.querySelector('script')).toBeNull();
		expect(bad.querySelector('img')).toBeNull();
		expect(bad.textContent).toContain('安全');
	});

	it('alert container paints with its accent styling and title (spec 3.1)', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('> [!NOTE] 标题行\n> 提示内容'));
		const alert = root.querySelector('.alert');
		expect(alert?.classList.contains('alert-note')).toBe(true);
		expect(alert!.textContent).toContain('提示内容');
		// layout.css: .alert { border-radius: 0 var(--radius-md) … } — the squared
		// top-left corner is the painted signature of the accent bar
		expect(getComputedStyle(alert!).borderTopLeftRadius).toBe('0px');
		const title = root.querySelector('.alert-title');
		expect(title?.textContent).toBe('标题行');
		expect(getComputedStyle(title!).fontWeight).toBe('600');
	});

	it('spoiler/mark/math stay inert inside inline code', () => {
		const root = mountHtml(renderMarkdownToHtmlSync('`||x|| ==y== $z$`'));
		expect(root.querySelector('span.spoiler')).toBeNull();
		expect(root.querySelector('mark')).toBeNull();
		expect(root.querySelector('.katex')).toBeNull();
	});

	it('grid paints as a css grid with the requested column count (spec 3.2)', () => {
		const root = mountHtml(
			renderMarkdownToHtmlSync(
				':::grid{cols=3}\n![](https://example.com/a.png)\n![](https://example.com/b.png)\n:::'
			)
		);
		const grid = root.querySelector('.md-grid') as HTMLElement | null;
		expect(grid).not.toBeNull();
		expect(getComputedStyle(grid!).display).toBe('grid');
		expect(getComputedStyle(grid!).gridTemplateColumns.split(' ').length).toBe(3);
	});

	it('details paints closed by default and open when asked (spec 3.2)', () => {
		const closed = mountHtml(renderMarkdownToHtmlSync(':::spoiler\n隐藏内容\n:::'));
		const d1 = closed.querySelector('details') as HTMLDetailsElement | null;
		expect(d1).not.toBeNull();
		expect(d1!.open).toBe(false);
		expect(d1!.querySelector('summary')?.textContent).toBe('剧透');
		const opened = mountHtml(
			renderMarkdownToHtmlSync(':::details{summary="更多" open}\n内容\n:::')
		);
		const d2 = opened.querySelector('details') as HTMLDetailsElement | null;
		expect(d2!.open).toBe(true);
	});

	it('tabs paints its label and panel structure (spec 3.2)', () => {
		const root = mountHtml(
			renderMarkdownToHtmlSync('::::tabs\n:::tab{label="一"}\n面板一\n:::\n::::')
		);
		expect(root.querySelector('.md-tabs')).not.toBeNull();
		expect(root.querySelector('.md-tab-label')?.textContent).toBe('一');
		expect(root.textContent).toContain('面板一');
	});

	it('raw html gets the 4.5 closed set end to end, pipeline output keeps its classes (spec 4.5)', () => {
		const root = mountHtml(
			renderMarkdownToHtmlSync(
				'<div class="raw-x" style="position:fixed">R</div>\n\n:::grid{cols=2}\n内容\n:::'
			)
		);
		expect(root.querySelector('.raw-x')).toBeNull();
		expect(root.querySelector('[style]')).toBeNull();
		expect(root.querySelector('.md-grid')).not.toBeNull();
		expect(root.querySelector('.md-grid')!.getAttribute('data-cols')).toBe('2');
	});

	it('heading anchors paint and carry encoded hrefs (spec 3.6)', () => {
		const root = mountMarkdown('# 中文标题');
		const h1 = root.querySelector('h1') as HTMLElement;
		expect(h1.id).toBe('中文标题');
		const anchor = h1.querySelector('a.md-anchor') as HTMLAnchorElement;
		expect(anchor.getAttribute('href')).toBe('#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98');
		// layout.css hides the anchor until the heading is hovered
		expect(getComputedStyle(anchor).opacity).toBe('0');
	});

	it('code info-string blocks paint collapsed with a titled summary (spec 3.3)', () => {
		const collapsed = mountHtml(
			renderMarkdownToHtmlSync('```ts {collapsed title="核心逻辑"}\nhello\n```')
		);
		const details = collapsed.querySelector('details.md-code-collapsed') as HTMLDetailsElement;
		expect(details).not.toBeNull();
		expect(details.open).toBe(false);
		expect(details.querySelector('summary')?.textContent).toBe('核心逻辑');
		expect(details.textContent).toContain('hello');

		const titled = mountHtml(renderMarkdownToHtmlSync('```ts {title="核心逻辑"}\nhello\n```'));
		expect(titled.querySelector('.md-code-title')?.textContent).toBe('核心逻辑');
	});

	it('image tail size paints as attributes (spec 2 #7)', () => {
		const root = mountHtml(
			renderMarkdownToHtmlSync('![a](https://example.com/a.png) {width=480 height=320}')
		);
		const img = root.querySelector('img') as HTMLImageElement;
		expect(img.getAttribute('width')).toBe('480');
		expect(img.getAttribute('height')).toBe('320');
	});
});

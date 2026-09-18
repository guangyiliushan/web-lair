/**
 * Conformance case set -- maps the layered markdown spec v0.3 (4/5/9).
 *
 * Every case runs on both the server pipeline (src/lib/server/markdown.ts)
 * and the client light pipeline (markdown-config.ts); both outputs must
 * satisfy the assertions.
 *
 * Assertions use contains/notContains instead of full HTML snapshots: the
 * two pipelines differ in code-highlighting output (Shiki vs plain text),
 * and smallest-common-subset assertions lock behavior while staying robust
 * to implementation details.
 *
 * Maintenance: migration batches append target-behavior cases here first
 * (red); implementations turn them green. ids are stable and the spec
 * section lives in the `spec` field.
 */

export interface ConformanceCase {
	/** stable id, shaped <layer>-<item>-<slug> */
	id: string;
	/** the spec section it maps to, e.g. "§4.2" */
	spec: string;
	/** input markdown source */
	input: string;
	/** fragments the rendered output must contain */
	contains: string[];
	/** fragments the rendered output must not contain */
	notContains?: string[];
}

export const conformanceCases: ConformanceCase[] = [
	// L0 base
	{
		id: 'l0-basic-emphasis',
		spec: '§1',
		input: '这是 **加粗** 与 *斜体* 文本',
		contains: ['<strong>加粗</strong>', '<em>斜体</em>']
	},
	{
		id: 'l0-inline-code-protects-markers',
		spec: '§4.2',
		input: '行内 `a || b == c #x# GH@user` 不解析',
		contains: ['<code>a || b == c #x# GH@user</code>'],
		notContains: ['<span class="spoiler">', '<span class="tag">', 'class="mention"']
	},
	{
		id: 'l0-backslash-escape',
		spec: '§4.4',
		input: '字面 \\*星号\\* 与 \\\\ 反斜杠',
		contains: ['*星号*', '\\']
	},
	{
		id: 'l0-fenced-code',
		spec: '§1',
		input: '```\nconst x = 1\n```',
		contains: ['<pre', '<code']
	},

	// L1 base (GFM)
	{
		id: 'l1-strikethrough',
		spec: '§1',
		input: '~~删除线~~',
		contains: ['<del>删除线</del>']
	},
	{
		id: 'l1-task-list',
		spec: '§1',
		input: '- [ ] 待办\n- [x] 完成',
		contains: ['type="checkbox"', '待办', '完成']
	},
	{
		id: 'l1-table',
		spec: '§1',
		input: '| 左 | 右 |\n| :-- | --: |\n| a | b |',
		contains: ['<table>', '<th', 'a', 'b']
	},
	{
		id: 'l1-autolink',
		spec: '§1',
		input: '<https://example.com>',
		contains: ['<a href="https://example.com"']
	},
	{
		id: 'l1-footnote',
		spec: '§2 #3',
		input: '正文[^1]\n\n[^1]: 脚注内容',
		contains: ['脚注内容']
	},

	// L2 inline
	{
		id: 'l2-math-inline',
		spec: '§2 #2',
		input: '质能方程 $E=mc^2$ 成立',
		contains: ['katex'],
		notContains: ['$E=mc^2$']
	},
	{
		id: 'l2-math-block',
		spec: '§2 #2',
		input: '$$\n\\int_0^1 x\\,dx\n$$',
		contains: ['katex-display']
	},
	{
		id: 'l2-math-error-recovers',
		spec: '§5',
		input: '$\\foo{bar}$',
		contains: ['katex']
	},
	{
		id: 'l2-spoiler-inline',
		spec: '§2 #6',
		input: '剧透 ||隐藏内容|| 结束',
		contains: ['<span class="spoiler">隐藏内容</span>']
	},
	{
		// The "explicitly absent" list of spec 2 retires the #x# syntax; tags move
		// to the 4.5 whitelist <tag> element, styled by the site layer (L3) via
		// element selectors — the renderer adds no class
		id: 'l2-tag-html-element',
		spec: '§4.5',
		input: '标记 <tag>重要</tag> 结束',
		contains: ['<tag>重要</tag>']
	},

	// L2 inline: ==mark== (micromark attention)
	{
		id: 'l2-mark-basic',
		spec: '§2 #5',
		input: '高亮 ==重点== 结束',
		contains: ['<mark>重点</mark>']
	},
	{
		id: 'l2-mark-flanking-space-separated',
		spec: '§4.3',
		input: 'a == b == c',
		contains: ['a == b == c'],
		notContains: ['<mark>']
	},
	{
		id: 'l2-mark-flanking-plus-increment',
		spec: '§4.3',
		input: 'i++ == ++i',
		contains: ['i++ == ++i'],
		notContains: ['<mark>']
	},
	{
		id: 'l2-mark-flanking-punctuation-boundary',
		spec: '§4.3',
		input: '这是（==重点==）注意',
		contains: ['<mark>重点</mark>']
	},
	{
		id: 'l2-mark-escape',
		spec: '§4.4',
		input: '字面 \\=\\=x\\=\\= 不高亮',
		contains: ['==x=='],
		notContains: ['<mark>']
	},
	{
		id: 'l2-mark-inside-math-disabled',
		spec: '§4.2',
		input: '$a == b$',
		contains: ['katex'],
		notContains: ['<mark>']
	},
	{
		id: 'l2-mark-inside-inline-code-disabled',
		spec: '§4.2',
		input: '行内代码 `==x==` 不解析',
		contains: ['<code>==x==</code>'],
		notContains: ['<mark>']
	},
	{
		id: 'l2-mark-table-cell-allowed',
		spec: '§4.2',
		input: '| a | ==b== |\n| --- | --- |',
		contains: ['<mark>b</mark>']
	},
	{
		id: 'l2-mark-nested-with-emphasis',
		spec: '§4.1',
		input: '==*斜体加亮*==',
		// lock the full nested structure: a missing wrapper or wrong order must fail
		contains: ['<mark><em>斜体加亮</em></mark>']
	},
	{
		id: 'l2-mark-odd-markers-stay-literal',
		spec: '§2 #5',
		input: '三个 === 定界符保持字面',
		contains: ['==='],
		notContains: ['<mark>']
	},

	// L2 inline: ||spoiler|| guards (micromark attention)
	{
		id: 'l2-spoiler-flanking-space-separated',
		spec: '§4.3',
		input: 'a || b || c',
		contains: ['a || b || c'],
		notContains: ['class="spoiler"']
	},
	{
		id: 'l2-spoiler-escape',
		spec: '§4.4',
		input: '字面 \\|\\|x\\|\\| 不剧透',
		contains: ['||x||'],
		notContains: ['class="spoiler"']
	},
	{
		id: 'l2-spoiler-inside-math-disabled',
		spec: '§4.2',
		input: '$‖x‖ 与 a || b$',
		contains: ['katex'],
		notContains: ['class="spoiler"']
	},
	{
		// 4.2 table-cell ban on `||` in practice: a bare `||` is consumed by the
		// GFM table structure as a cell delimiter (not a spoiler concern); what can
		// enter cell inline content is the escaped form `\|\|`, which must stay
		// literal and never become a spoiler.
		id: 'l2-spoiler-table-cell-disabled',
		spec: '§4.2',
		input: '| a | x \\|\\|剧透\\|\\| y |\n| --- | --- |',
		notContains: ['class="spoiler"'],
		contains: ['||剧透||']
	},
	{
		id: 'l2-spoiler-odd-markers-stay-literal',
		spec: '§2 #6',
		input: '三个 ||| 定界符保持字面',
		contains: ['|||'],
		notContains: ['class="spoiler"']
	},

	// L2 inline: math guard (2 #2)
	{
		id: 'l2-math-guard-price-pair',
		spec: '§2 #2',
		input: '价格 $5,成本 $3 均为字面',
		notContains: ['katex'],
		contains: ['$5']
	},
	{
		id: 'l2-math-guard-letter-before-opener',
		spec: '§2 #2',
		input: '字母后$x+y$保持字面',
		notContains: ['katex'],
		contains: ['$x+y$']
	},
	{
		id: 'l2-math-guard-digit-after-closer',
		spec: '§2 #2',
		input: '$1+1$2 后跟数字保持字面',
		notContains: ['katex'],
		contains: ['$1+1$']
	},
	{
		id: 'l2-math-guard-underscore-before-opener',
		spec: '§2 #2',
		input: '变量 tail_$x$ 保持字面',
		notContains: ['katex'],
		contains: ['$x$']
	},
	{
		id: 'l2-math-guard-unicode-digit-after-closer',
		spec: '§2 #2',
		input: '$x$１ 全角数字保持字面',
		notContains: ['katex'],
		contains: ['$x$']
	},

	// L2 inline: mention (§2 #4 / §3.5)
	{
		id: 'l2-mention-bare-gh',
		spec: '§2 #4',
		input: '找 @gh:octocat 看看',
		// attribute order is a hast serialization detail — assert the parts
		contains: ['class="mention"', 'href="@gh:octocat"', '>@gh:octocat</a>']
	},
	{
		id: 'l2-mention-link-form',
		spec: '§3.5',
		input: '[自定义名](@gh:Innei) 链接式',
		contains: ['href="@gh:Innei"', '自定义名']
	},
	{
		id: 'l2-mention-platforms',
		spec: '§2 #4',
		input: '@tw:jack 与 @tg:ann',
		contains: ['href="@tw:jack"', 'href="@tg:ann"']
	},
	{
		id: 'l2-mention-unknown-platform-literal',
		spec: '§5',
		input: '未知平台 @ft:someone 保持字面',
		notContains: ['class="mention"'],
		contains: ['@ft:someone']
	},
	{
		id: 'l2-mention-needs-boundary',
		spec: '§2 #4',
		input: '字母后@gh:x 不触发',
		contains: ['@gh:x'],
		notContains: ['class="mention"']
	},
	{
		id: 'l2-mention-after-punctuation',
		spec: '§2 #4',
		input: '（@gh:x）标点后触发',
		contains: ['href="@gh:x"']
	},
	{
		id: 'l2-mention-email-unaffected',
		spec: '§2 #4',
		input: '邮件 foo@example.com 正常',
		notContains: ['class="mention"'],
		contains: ['foo@example.com']
	},
	{
		// regex semantics of the plan's `{1,40}`: the first 40 characters form
		// the mention, everything beyond stays literal text
		id: 'l2-mention-username-max-40',
		spec: '§2 #4',
		input: '@gh:' + 'a'.repeat(41),
		contains: ['href="@gh:' + 'a'.repeat(40) + '"'],
		notContains: ['href="@gh:' + 'a'.repeat(41) + '"']
	},
	{
		// inside a link label a mention must stay literal — an anchor nested in
		// the label would truncate the outer link (port of the official
		// autolink-literal `previousUnbalanced` guard)
		id: 'l2-mention-inside-link-label-literal',
		spec: '§2 #4',
		input: '[见 @gh:x 说明](https://example.com)',
		contains: ['href="https://example.com"', '>见 @gh:x 说明</a>'],
		notContains: ['class="mention"']
	},

	// §4.5 raw-HTML whitelist and stripping
	{
		id: 'l45-whitelist-kbd-kept',
		spec: '§4.5',
		input: '按 <kbd>Ctrl</kbd> 键',
		contains: ['<kbd>Ctrl</kbd>']
	},
	{
		id: 'l45-whitelist-details-kept',
		spec: '§4.5',
		input: '<details open><summary>展开</summary>内容</details>',
		contains: ['<details', '<summary>展开</summary>', '内容']
	},
	{
		id: 'l45-raw-img-stripped',
		spec: '§4.5',
		input: '前面 <img src="https://evil.example/x.png" onerror="alert(1)"> 后面',
		notContains: ['<img', 'onerror'],
		contains: ['前面', '后面']
	},
	{
		id: 'l45-script-stripped',
		spec: '§6',
		input: '安全 <script>alert(1)</script> 通过',
		notContains: ['<script', 'alert'],
		contains: ['安全', '通过']
	},
	{
		id: 'l45-iframe-stripped',
		spec: '§4.5',
		input: '<iframe src="https://evil.example"></iframe>内容',
		notContains: ['<iframe'],
		contains: ['内容']
	},
	{
		id: 'l45-style-tag-stripped',
		spec: '§4.5',
		input: '<style>p{color:red}</style>文本',
		notContains: ['<style', 'color:red'],
		contains: ['文本']
	},
	{
		id: 'l45-event-handler-stripped',
		spec: '§4.5',
		input: '<kbd onmouseover="alert(1)">x</kbd>',
		notContains: ['onmouseover', 'alert'],
		contains: ['<kbd', 'x']
	},
	{
		id: 'l45-javascript-href-blocked',
		spec: '§6',
		input: '[链接](javascript:alert(1)) 保持安全',
		notContains: ['javascript:'],
		contains: ['链接']
	},
	{
		id: 'l45-data-src-blocked',
		spec: '§4.5',
		input: '![x](data:image/png;base64,AAAA)',
		notContains: ['data:image'],
		contains: ['x']
	},
	{
		id: 'l45-unknown-tag-unwrapped',
		spec: '§4.5',
		input: '<custom-el>剥壳保文本</custom-el>',
		notContains: ['<custom-el>'],
		contains: ['剥壳保文本']
	},
	{
		// micromark-extension-directive parses a bare `:word` out of ordinary
		// prose; the closed L2 set has no text/leaf directives, so the literal
		// source must come back (spec 5: content is never swallowed)
		id: 'l5-text-directive-restored-literal',
		spec: '§5',
		input: '说明:内容 与 12:30 保持字面',
		contains: ['说明:内容', '12:30'],
		notContains: ['<div']
	},

	// L2 block
	{
		id: 'l2-alert-note-basic',
		spec: '§3.1',
		input: '> [!NOTE]\n> 提示内容',
		contains: ['alert alert-note', '提示内容']
	},
	{
		id: 'l2-alert-title',
		spec: '§3.1',
		input: '> [!TIP] 自定义标题\n> 正文',
		contains: ['alert alert-tip', '<p class="alert-title">自定义标题</p>', '正文']
	},
	{
		id: 'l2-alert-nested-markdown',
		spec: '§3.1',
		input: '> [!WARNING]\n> - 项一\n> - 项二\n>\n> **粗体**',
		contains: ['alert alert-warning', '<li>项一</li>', '<li>项二</li>', '<strong>粗体</strong>']
	},
	{
		id: 'l2-alert-nested-quote',
		spec: '§3.1',
		input: '> [!IMPORTANT] 标题\n> > 嵌套引用',
		contains: ['alert alert-important', '<blockquote>', '嵌套引用']
	},
	{
		id: 'l2-alert-case-insensitive',
		spec: '§3.1',
		input: '> [!Caution] 小写\n> 内容',
		contains: ['alert alert-caution', '小写']
	},
	{
		// hard break (two trailing spaces) must split title from body as well
		id: 'l2-alert-hard-break-title',
		spec: '§3.1',
		input: '> [!NOTE] 标题  \n> 正文',
		contains: ['<p class="alert-title">标题</p>', '<p>正文</p>']
	},
	{
		// spec 3.1 fixed migration mapping: error/danger -> CAUTION, success -> TIP
		id: 'l2-alert-alias-danger',
		spec: '§3.1',
		input: '> [!DANGER] 旧别名\n> 内容',
		contains: ['alert alert-caution', '旧别名']
	},
	{
		id: 'l2-alert-unknown-marker-fallback',
		spec: '§5',
		input: '> [!UNKNOWN] 未知标记\n> 正文',
		contains: ['<blockquote>', '[!UNKNOWN] 未知标记'],
		notContains: ['alert']
	},
	{
		id: 'l2-alert-plain-quote-untouched',
		spec: '§3.1',
		input: '> 普通引用内容',
		contains: ['<blockquote>', '普通引用内容'],
		notContains: ['alert']
	},
	{
		id: 'l2-html-sup-sub',
		spec: '§4.5',
		input: 'x<sup>2</sup> 与 y<sub>1</sub>',
		contains: ['<sup>2</sup>', '<sub>1</sub>']
	},

	// 5 error recovery
	{
		id: 'l5-unknown-container-renders-content',
		spec: '§5',
		input: ':::unknownbox\n正文照常\n:::',
		contains: ['正文照常']
	},
	{
		id: 'l5-unknown-lang-falls-back',
		spec: '§5',
		input: '```nosuchlang\nplain text\n```',
		contains: ['<pre', 'plain text']
	},
	{
		id: 'l5-content-never-swallowed',
		spec: '§5',
		input: ':::info\n孤儿容器内容',
		contains: ['孤儿容器内容']
	},
	// ── L2 containers (spec 3.2, batch 4a: grid/tabs/tab/details; gallery and banner retired) ──
	{
		id: 'l2-grid-basic',
		spec: '§3.2',
		input: ':::grid{cols=3 gap=8}\n![](https://example.com/a.png)\n:::',
		contains: ['class="md-grid', 'data-cols="3"', 'data-gap="8"', '<img']
	},
	{
		id: 'l2-grid-layout-type-rows',
		spec: '§3.2',
		input: ':::grid{layout=masonry type=images rows=2}\n![](https://example.com/a.png)\n:::',
		contains: ['data-layout="masonry"', 'data-type="images"', 'data-rows="2"']
	},
	{
		id: 'l2-grid-unknown-key-ignored',
		spec: '§3.2',
		input: ':::grid{cols=2 bogus=9}\n内容\n:::',
		contains: ['data-cols="2"'],
		notContains: ['bogus']
	},
	{
		id: 'l2-grid-out-of-range-falls-back',
		spec: '§3.2',
		input: ':::grid{cols=99 gap=7}\n内容\n:::',
		contains: ['class="md-grid'],
		notContains: ['data-cols', 'data-gap']
	},
	{
		id: 'l2-tabs-structure',
		spec: '§3.2',
		input:
			'::::tabs\n:::tab{label="标签一"}\n面板一\n:::\n:::tab{label="标签二"}\n面板二\n:::\n::::',
		contains: [
			'class="md-tabs',
			'class="md-tab',
			'md-tab-label',
			'标签一',
			'面板一',
			'标签二',
			'面板二'
		]
	},
	{
		id: 'l2-details-summary-open',
		spec: '§3.2',
		input: ':::details{summary="更多信息" open}\n详情内容\n:::',
		contains: ['<details', 'class="md-details"', '<summary>更多信息</summary>', '详情内容', 'open']
	},
	{
		id: 'l2-spoiler-block-sugar',
		spec: '§3.2',
		input: ':::spoiler{label="点我"}\n剧透内容\n:::',
		contains: ['<details', 'md-spoiler', '<summary>点我</summary>', '剧透内容']
	},
	{
		id: 'l2-spoiler-default-label',
		spec: '§3.2',
		input: ':::spoiler\n内容\n:::',
		contains: ['<summary>剧透</summary>']
	},
	{
		id: 'l2-container-retired-gallery-content-kept',
		spec: '§3.2+§5',
		input: ':::gallery\n![a](https://example.com/a.png)\n:::',
		contains: ['<img', 'a.png'],
		notContains: ['gallery']
	},
	{
		id: 'l2-container-unknown-content-kept',
		spec: '§5',
		input: ':::whatever\n内容保留\n:::',
		contains: ['内容保留']
	},
	// ── 4.5 raw/pipeline origin split (batch 4a) ──
	{
		// the forged token value cannot match the runtime random token
		id: 'l45-raw-class-style-stripped',
		spec: '§4.5',
		input: '<div data-md-x="forged" class="x" style="position:fixed">D</div>',
		contains: ['D'],
		notContains: ['class="x"', 'style=', 'data-md-x']
	},
	{
		id: 'l45-raw-element-unwrapped',
		spec: '§4.5',
		input: 'text <b>bold</b> <a href="https://example.com">link</a> end',
		contains: ['bold', 'link'],
		notContains: ['<b>', '<a ']
	},
	{
		id: 'l45-raw-allowed-keeps-kbd-strips-attrs',
		spec: '§4.5',
		input: '<kbd class="k" style="color:red">Ctrl</kbd>',
		contains: ['<kbd>', 'Ctrl'],
		notContains: ['class=', 'style=']
	},
	{
		id: 'l45-raw-id-kept-and-clobbered',
		spec: '§4.5',
		input: '<kbd id="my-key">K</kbd>',
		contains: ['id="user-content-my-key"']
	},
	{
		id: 'l45-raw-span-unwrapped',
		spec: '§4.5',
		input: '<span style="color:red">S</span>',
		contains: ['S'],
		notContains: ['<span', 'style=']
	},
	{
		id: 'l45-raw-video-attrs-reduced',
		spec: '§4.5',
		input: '<video src="https://example.com/v.mp4" class="v" controls="1"></video>',
		contains: ['<video', 'src="https://example.com/v.mp4"'],
		notContains: ['class=', 'controls']
	},
	{
		id: 'l45-pipeline-keeps-classes-and-strips-marker',
		spec: '§4.5',
		input: ':::grid{cols=2}\n内容\n:::',
		contains: ['class="md-grid', 'data-cols="2"'],
		notContains: ['data-md-x', 'dataMdX']
	},
	{
		id: 'l45-pipeline-img-kept-raw-img-dropped',
		spec: '§4.5',
		input: '![a](https://example.com/keep.png)\n\n<img src="https://evil.example/drop.png">',
		contains: ['keep.png'],
		notContains: ['evil.example']
	},
	// an unclosed raw wrapper makes parse5 nest following pipeline nodes inside
	// it; unwrapping must not re-classify those nodes as raw (their token must
	// survive to a decision that never mutates its own input)
	{
		id: 'l45-raw-wrapper-keeps-pipeline-image',
		spec: '§4.5',
		input: '<div class="box">\n\n![a](https://example.com/in-box.png)',
		contains: ['<img', 'in-box.png'],
		notContains: ['class="box"']
	},
	{
		id: 'l45-raw-wrapper-keeps-pipeline-table',
		spec: '§4.5',
		input: '<div class="box">\n\n| a | b |\n| - | - |\n| 1 | 2 |',
		contains: ['<table>', '<td>1</td>'],
		notContains: ['class="box"']
	},
	{
		id: 'l45-raw-wrapper-keeps-container-wrapper',
		spec: '§4.5',
		input: '<div class="box">\n\n:::grid{cols=2}\n内容\n:::',
		contains: ['class="md-grid', 'data-cols="2"'],
		notContains: ['class="box"']
	},
	{
		id: 'l45-raw-wrapper-nested-raw-still-stripped',
		spec: '§4.5',
		input: '<div class="box">\n\n<b>bold-raw</b>',
		contains: ['bold-raw'],
		notContains: ['<b>', 'class="box"']
	}
];

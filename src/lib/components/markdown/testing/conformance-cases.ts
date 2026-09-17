/**
 * Conformance 用例集 — 对应《分层 Markdown 语法规范 v0.3》§4/§5/§9。
 *
 * 每条用例在服务端管线(src/lib/server/markdown.ts)与客户端轻量管线
 * (markdown-config.ts)上运行,输出必须一致满足断言。
 *
 * 断言采用 contains/notContains 而非整段 HTML 快照:两条管线的代码高亮
 * 输出不同(Shiki vs 纯文本),最小公集断言足以锁定行为且对实现细节鲁棒。
 *
 * 维护约定:迁移批次先在此追加目标行为用例(红),实现后转绿(红→绿)。
 * id 稳定不变,规范章节写在 spec 字段。
 */

export interface ConformanceCase {
	/** 稳定 id,格式 <层>-<条目>-<slug> */
	id: string;
	/** 对应规范章节,如 "§4.2" */
	spec: string;
	/** 输入 markdown 源 */
	input: string;
	/** 渲染输出必须包含的片段 */
	contains: string[];
	/** 渲染输出必须不包含的片段 */
	notContains?: string[];
}

export const conformanceCases: ConformanceCase[] = [
	// ── L0 基座 ──
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

	// ── L1 基座(GFM)──
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

	// ── L2 行内 ──
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
		id: 'l2-mention-gh',
		spec: '§2 #4',
		input: '找 GH@octocat 看看',
		contains: ['class="mention"', 'octocat']
	},
	{
		id: 'l2-tag',
		spec: '§2(遗留 #x#)',
		input: '标记 #tag# 结束',
		contains: ['<span class="tag">tag</span>']
	},

	// ── L2 块级 ──
	{
		id: 'l2-callout-info',
		spec: '§3.1(遗留 :::info)',
		input: ':::info\n提示内容\n:::',
		contains: ['callout-info', '提示内容']
	},
	{
		id: 'l2-callout-nested-markdown',
		spec: '§3.1',
		input: ':::info\n- 项一\n- 项二\n:::',
		contains: ['<li>项一</li>', '<li>项二</li>']
	},
	{
		id: 'l2-html-sup-sub',
		spec: '§4.5',
		input: 'x<sup>2</sup> 与 y<sub>1</sub>',
		contains: ['<sup>2</sup>', '<sub>1</sub>']
	},

	// ── §5 错误恢复 ──
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
	}
];

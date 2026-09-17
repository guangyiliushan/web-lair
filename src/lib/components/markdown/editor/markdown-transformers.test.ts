import { describe, it, expect } from 'vitest';
import { createEditor, type LexicalEditor } from 'lexical';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { TagNode } from '$lib/components/markdown/tag/tag-node';
import { AlertNode } from '$lib/components/markdown/alert/alert-node';
import { EDITOR_NODES } from './editor-nodes';
import {
	EDITOR_TRANSFORMERS,
	tagTransformer,
	alertTransformer,
	alertJsonToMarkdown,
	markdownToAlertJson
} from './markdown-transformers';

/**
 * 编辑器 Markdown 往返辅助：markdown → Lexical 树 → markdown。
 * 使用与生产 lexicalEditor action 相同的节点注册与 transformer 列表。
 */
function roundtrip(markdown: string): string {
	const editor: LexicalEditor = createEditor({
		namespace: 'markdown-transformers-test',
		nodes: EDITOR_NODES,
		onError: (error: Error) => {
			throw error;
		}
	});
	editor.update(
		() => {
			$convertFromMarkdownString(markdown, EDITOR_TRANSFORMERS);
		},
		{ discrete: true }
	);
	let out = '';
	editor.getEditorState().read(() => {
		out = $convertToMarkdownString(EDITOR_TRANSFORMERS);
	});
	return out;
}

/** 从导出的 markdown 中提取 callout 容器内容，用于验证嵌套 JSON 转换 */
function extractAlertMarkdown(exported: string): string {
	const match = exported.match(/:::(?:info|tip|warning)\n([\s\S]*?)\n:::/);
	return match?.[1] ?? '';
}

describe('markdown transformers roundtrip', () => {
	it('resolves transformer dependencies under editor-nodes-first import order', () => {
		expect(tagTransformer.dependencies).toEqual([TagNode]);
		expect(alertTransformer.dependencies).toEqual([AlertNode]);
	});

	it('preserves headings, paragraphs, tags and alert containers', () => {
		const md = '# 标题\n\n正文 #tag#\n\n:::info\n- 项一\n- 项二\n:::';
		const out = roundtrip(md);

		expect(out).toContain('# 标题');
		expect(out).toContain('#tag#');
		expect(out).toContain(':::info');
		expect(out).toContain('- 项一');
		expect(out).toContain('- 项二');
	});

	it('is stable on a second roundtrip (idempotent)', () => {
		const md = '# 标题\n\n正文 #tag#\n\n:::info\n- 项一\n- 项二\n:::';
		const once = roundtrip(md);
		const twice = roundtrip(once);
		expect(twice).toBe(once);
	});

	it('exports TagNode as #text#', () => {
		const out = roundtrip('前文 #svelte# 后文');
		expect(out).toContain('#svelte#');
		expect(out).not.toContain('前文 #svelte# 后文 #svelte#');
	});

	it('exports alert with its type intact', () => {
		const out = roundtrip(':::warning\n注意内容\n:::');
		expect(out).toContain(':::warning');
		expect(out).toContain('注意内容');
		expect(out).toContain(':::');
	});

	it('keeps nested lists and headings inside alert containers', () => {
		const out = roundtrip(':::tip\n### 小节\n\n- a\n- b\n:::');
		const inner = extractAlertMarkdown(out);
		expect(inner).toContain('### 小节');
		expect(inner).toContain('- a');
		expect(inner).toContain('- b');
	});

	it('does not treat headings as tags', () => {
		const out = roundtrip('# 标题一');
		expect(out).toContain('# 标题一');
	});

	it('handles multiple tags in one paragraph', () => {
		const out = roundtrip('同时使用 #alpha# 与 #beta#');
		expect(out).toContain('#alpha#');
		expect(out).toContain('#beta#');
	});
});

describe('phase 1-6 新增能力 roundtrip', () => {
	it('roundtrips horizontal rule (---)', () => {
		const out = roundtrip('前文\n\n---\n\n后文');
		expect(out).toContain('---');
		expect(out).toContain('前文');
		expect(out).toContain('后文');
	});

	it('roundtrips standalone image as ImageNode', () => {
		const out = roundtrip('![替代文本](https://example.com/a.png)');
		expect(out).toContain('![替代文本](https://example.com/a.png)');
	});

	it('keeps inline image markdown as text (block-only policy)', () => {
		const out = roundtrip('行内 ![图](https://example.com/a.png) 文本');
		// 段落内的 ![...](...) 保持原样（渲染管线转为 <img>）
		expect(out).toContain('![图](https://example.com/a.png)');
	});

	it('roundtrips GFM pipe table', () => {
		const md = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |';
		const out = roundtrip(md);
		expect(out).toContain('| 名称 | 数量 |');
		expect(out).toContain('| --- | --- |');
		expect(out).toContain('| 苹果 | 3 |');
		expect(out).toContain('| 香蕉 | 5 |');
	});

	it('roundtrips table with inline formatting in cells', () => {
		const md = '| A | B |\n| --- | --- |\n| **加粗** | `代码` |';
		const out = roundtrip(md);
		expect(out).toContain('| **加粗** | `代码` |');
	});

	it('escapes and restores pipes inside table cells', () => {
		const md = '| A | B |\n| --- | --- |\n| a\\|b | c |';
		const out = roundtrip(md);
		expect(out).toContain('a\\|b');
	});

	it('roundtrips alignment directive', () => {
		const md = ':::center\n居中的内容\n:::';
		const out = roundtrip(md);
		expect(out).toContain(':::center');
		expect(out).toContain('居中的内容');
	});

	it('roundtrips alignment directive wrapping a heading', () => {
		const md = ':::center\n# 居中标题\n:::';
		const out = roundtrip(md);
		expect(out).toContain(':::center');
		expect(out).toContain('# 居中标题');
	});

	it('keeps aligned block content intact when followed by an alert (temp editor reuse)', () => {
		const out = roundtrip(':::center\n居中的内容\n:::\n\n:::info\n提示内容\n:::');
		const centerBlock = out.match(/:::center\n([\s\S]*?)\n:::/)?.[1] ?? '';
		// 对齐块内容不能被后续 alert 的 temp editor 解析结果污染
		expect(centerBlock).toBe('居中的内容');
		expect(out).toContain(':::info');
		expect(out).toContain('提示内容');
	});

	it('keeps aligned block content intact when followed by a table (temp editor reuse)', () => {
		const out = roundtrip(':::center\n居中的内容\n:::\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
		const centerBlock = out.match(/:::center\n([\s\S]*?)\n:::/)?.[1] ?? '';
		expect(centerBlock).toBe('居中的内容');
		expect(out).toContain('| A | B |');
		expect(out).toContain('| 1 | 2 |');
	});

	it('roundtrips superscript and subscript', () => {
		const md = '质能方程 <sup>x^2</sup> 与化学式 <sub>n+1</sub>';
		const out = roundtrip(md);
		expect(out).toContain('<sup>x^2</sup>');
		expect(out).toContain('<sub>n+1</sub>');
	});

	it('roundtrips checklist items', () => {
		const md = '- [ ] 待办事项\n- [x] 已完成';
		const out = roundtrip(md);
		expect(out).toContain('- [ ] 待办事项');
		expect(out).toContain('- [x] 已完成');
	});

	it('is stable on a second roundtrip for the full feature matrix', () => {
		const md = [
			'# 大标题',
			'',
			'正文 #tag# 与 <sup>上标</sup>',
			'',
			'- [ ] 待办',
			'',
			':::center',
			'居中段落',
			':::',
			'',
			':::info',
			'提示内容',
			':::',
			'',
			'| A | B |',
			'| --- | --- |',
			'| 1 | 2 |',
			'',
			'---',
			'',
			'![图片](https://example.com/i.png)'
		].join('\n');
		const once = roundtrip(md);
		const twice = roundtrip(once);
		expect(twice).toBe(once);
	});
});

describe('mark transformer (==x== <-> highlight)', () => {
	it('roundtrips ==mark== syntax', () => {
		expect(roundtrip('前 ==高亮== 后')).toBe('前 ==高亮== 后');
	});

	it('preserves nested formats inside marks', () => {
		// 核心 transformer 会规范化包裹顺序(mark 外层、粗体内层),语义等价
		const out = roundtrip('==**粗体高亮**==');
		expect(out).toBe('**==粗体高亮==**');
	});

	it('keeps plain == untouched in editor roundtrip', () => {
		// 编辑器侧不做贴靠判定(渲染端 micromark 保证),纯文本原样往返
		expect(roundtrip('a == b == c')).toBe('a == b == c');
	});
});

describe('alert json <-> markdown helpers', () => {
	it('converts markdown to alert json and back', () => {
		const json = markdownToAlertJson('- 项一\n- 项二\n\n段落');
		const md = alertJsonToMarkdown(json);
		expect(md).toContain('- 项一');
		expect(md).toContain('- 项二');
		expect(md).toContain('段落');
	});

	it('roundtrips alert json stably', () => {
		const json = markdownToAlertJson('### 标题\n\n内容 #tag#');
		const md = alertJsonToMarkdown(json);
		const json2 = markdownToAlertJson(md);
		expect(json2).toBe(json);
	});

	it('returns empty string for invalid json', () => {
		expect(alertJsonToMarkdown('not-json')).toBe('');
		expect(alertJsonToMarkdown('')).toBe('');
	});
});

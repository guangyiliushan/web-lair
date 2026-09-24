import { describe, it, expect } from 'vitest';
import {
	createEditor,
	$getRoot,
	$createParagraphNode,
	$setSelection,
	type ElementNode,
	type LexicalEditor,
	type TextNode
} from 'lexical';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { TagNode } from '$lib/components/markdown/tag/tag-node';
import { AlertNode } from '$lib/components/markdown/alert/alert-node';
import {
	ImageNode,
	$isImageNode,
	type SerializedImageNode
} from '$lib/components/markdown/image/image-node';
import { EDITOR_NODES } from './editor-nodes';
import { $createSpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { toggleSpoiler } from '$lib/components/markdown/editor/lexical-helpers';
import {
	mathInlineTransformer,
	mathParenTransformer
} from '$lib/components/markdown/math/math-transformers';
import {
	footnoteRefTransformer,
	footnoteInlineTransformer
} from '$lib/components/markdown/footnote/footnote-transformers';
import {
	EDITOR_TRANSFORMERS,
	tagTransformer,
	alertTransformer,
	alertJsonToMarkdown,
	markdownToAlertJson,
	normalizeChecklistMarkers,
	$unescapeImportedText
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
			$convertFromMarkdownString(normalizeChecklistMarkers(markdown), EDITOR_TRANSFORMERS);
			$unescapeImportedText();
		},
		{ discrete: true }
	);
	let out = '';
	editor.getEditorState().read(() => {
		out = $convertToMarkdownString(EDITOR_TRANSFORMERS);
	});
	return out;
}

/** Extracts the alert body (the `>` lines after the marker line) from an export. */
function extractAlertMarkdown(exported: string): string {
	const lines = exported.split('\n');
	const start = lines.findIndex((line) => /^> \[![a-zA-Z]+\]/.test(line));
	if (start === -1) return '';
	return lines
		.slice(start + 1)
		.filter((line) => line.startsWith('>'))
		.map((line) => line.replace(/^>\s?/, ''))
		.join('\n');
}

/** Node types present after importing markdown (recursive JSON walk). */
function treeTypes(markdown: string): string[] {
	const editor: LexicalEditor = createEditor({
		namespace: 'markdown-transformers-types',
		nodes: EDITOR_NODES,
		onError: (error: Error) => {
			throw error;
		}
	});
	editor.update(
		() => {
			$convertFromMarkdownString(normalizeChecklistMarkers(markdown), EDITOR_TRANSFORMERS);
			$unescapeImportedText();
		},
		{ discrete: true }
	);
	const types: string[] = [];
	editor.getEditorState().read(() => {
		const walk = (node: unknown): void => {
			if (
				node &&
				typeof node === 'object' &&
				typeof (node as { getType?: unknown }).getType === 'function'
			) {
				types.push((node as { getType: () => string }).getType());
				const children = (node as { getChildren?: () => unknown[] }).getChildren?.() ?? [];
				for (const child of children) walk(child);
			}
		};
		walk($getRoot());
	});
	return types;
}

describe('spoiler node roundtrip (batch A)', () => {
	it('converts ||x|| into a spoiler node and roundtrips exactly', () => {
		expect(treeTypes('||x||')).toContain('spoiler');
		expect(roundtrip('||x||')).toBe('||x||');
	});

	it('keeps escaped markers literal', () => {
		expect(treeTypes('\\|\\|x\\|\\|')).not.toContain('spoiler');
		const once = roundtrip('\\|\\|x\\|\\|');
		expect(roundtrip(once)).toBe(once);
	});

	it('does not convert empty, spaced or triple-run pairs', () => {
		expect(treeTypes('||||')).not.toContain('spoiler');
		expect(roundtrip('|| x ||')).toBe('|| x ||');
		expect(roundtrip('||x ||')).toBe('||x ||');
		expect(treeTypes('|||x|||')).not.toContain('spoiler');
		expect(roundtrip('|||x|||')).toBe('|||x|||');
	});

	it('handles two pairs on one line', () => {
		expect(treeTypes('||a|| 与 ||b||').filter((t) => t === 'spoiler')).toHaveLength(2);
		expect(roundtrip('||a|| 与 ||b||')).toBe('||a|| 与 ||b||');
	});

	it('never converts inside inline code format', () => {
		expect(treeTypes('`||x||`')).not.toContain('spoiler');
		expect(roundtrip('`||x||`')).toBe('`||x||`');
	});

	it('escapes literal format characters and keeps the escape stable (review F3)', () => {
		expect(roundtrip('||a*b*c||')).toBe('||a\\*b\\*c||');
		// second pass: the escape is undone on import and re-applied on export
		expect(roundtrip('||a\\*b\\*c||')).toBe('||a\\*b\\*c||');
	});

	it('serializes a formatted spoiler with core-canonical syntax (review F3)', () => {
		// core order: bold outside strikethrough (MarkdownTransformers 0.46)
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-transformers-test',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				const paragraph = $createParagraphNode();
				const spoiler = $createSpoilerNode('z');
				spoiler.setFormat('bold');
				spoiler.toggleFormat('strikethrough');
				paragraph.append(spoiler);
				$getRoot().append(paragraph);
			},
			{ discrete: true }
		);
		editor.getEditorState().read(() => {
			expect($convertToMarkdownString(EDITOR_TRANSFORMERS)).toBe('||**~~z~~**||');
		});
	});
});

describe('toggleSpoiler piece selection (batch A review F1)', () => {
	async function toggle(md: string, from: number, to: number): Promise<string> {
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-transformers-test',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				$convertFromMarkdownString(md, EDITOR_TRANSFORMERS);
			},
			{ discrete: true }
		);
		editor.update(
			() => {
				const paragraph = $getRoot().getFirstChild() as ElementNode;
				const text = paragraph.getChildren()[0] as TextNode;
				$setSelection(text.select(from, to));
			},
			{ discrete: true }
		);
		toggleSpoiler(editor);
		const readOut = () => {
			let out = '';
			editor.getEditorState().read(() => {
				out = $convertToMarkdownString(EDITOR_TRANSFORMERS);
			});
			return out;
		};
		// toggleSpoiler's update commits asynchronously (no discrete flag); flush one macrotask
		// before reading, mirroring how the toolbar measures state via polls.
		await new Promise((resolve) => setTimeout(resolve, 0));
		return readOut();
	}

	it('wraps the selected prefix when the selection starts at offset 0', async () => {
		expect(await toggle('abcdef', 0, 2)).toBe('||ab||cdef');
		expect(await toggle('abcdef', 2, 4)).toBe('ab||cd||ef');
		expect(await toggle('abcdef', 0, 6)).toBe('||abcdef||');
	});
});

describe('mention node roundtrip (batch A)', () => {
	it('converts @gh:user and roundtrips exactly', () => {
		expect(treeTypes('@gh:some_one')).toContain('mention');
		expect(roundtrip('@gh:some_one')).toBe('@gh:some_one');
	});

	it('keeps unknown platforms and malformed forms literal', () => {
		expect(treeTypes('@ft:someone')).not.toContain('mention');
		expect(treeTypes('@gh:')).not.toContain('mention');
		// render-side semantics: the username stops at the space, so a partial
		// mention plus literal text is the correct conversion
		expect(treeTypes('@gh:a b')).toContain('mention');
		expect(roundtrip('@gh:a b')).toBe('@gh:a b');
	});

	it('mirrors the boundary rule: line start, whitespace or punctuation only', () => {
		expect(treeTypes('中文@gh:x')).not.toContain('mention');
		expect(treeTypes('a@gh:x')).not.toContain('mention');
		expect(treeTypes('见 @gh:x 和, @tw:y')).toContain('mention');
		expect(treeTypes('(@gh:x)')).toContain('mention');
	});

	it('caps the username at 40 characters, the rest stays literal', () => {
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-transformers-test',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				$convertFromMarkdownString('@gh:' + 'u'.repeat(45), EDITOR_TRANSFORMERS);
			},
			{ discrete: true }
		);
		editor.getEditorState().read(() => {
			const paragraph = $getRoot().getFirstChild() as ElementNode;
			const children = paragraph.getChildren();
			expect(children[0].getType()).toBe('mention');
			expect(children[0].getTextContent()).toBe('@gh:' + 'u'.repeat(40));
			expect(children[1].getType()).toBe('text');
			expect(children[1].getTextContent()).toBe('uuuuu');
		});
	});

	it('never converts inside inline code format', () => {
		expect(treeTypes('`@gh:x`')).not.toContain('mention');
		expect(roundtrip('`@gh:x`')).toBe('`@gh:x`');
	});

	it('never converts an escaped mention (review F4)', () => {
		expect(treeTypes('\\@gh:user')).not.toContain('mention');
	});
});

describe('markdown transformers roundtrip', () => {
	it('resolves transformer dependencies under editor-nodes-first import order', () => {
		expect(tagTransformer.dependencies).toEqual([TagNode]);
		expect(alertTransformer.dependencies).toEqual([AlertNode]);
	});

	it('preserves headings, paragraphs, tags and alerts', () => {
		const md = '# 标题\n\n正文 <tag>标签</tag>\n\n> [!NOTE]\n> - 项一\n> - 项二';
		const out = roundtrip(md);

		expect(out).toContain('# 标题');
		expect(out).toContain('<tag>标签</tag>');
		expect(out).toContain('> [!NOTE]');
		expect(out).toContain('- 项一');
		expect(out).toContain('- 项二');
	});

	it('is stable on a second roundtrip (idempotent)', () => {
		const md = '# 标题\n\n正文 <tag>标签</tag>\n\n> [!NOTE]\n> - 项一\n> - 项二';
		const once = roundtrip(md);
		const twice = roundtrip(once);
		expect(twice).toBe(once);
	});

	it('exports TagNode as <tag>…</tag> exactly once', () => {
		const out = roundtrip('前文 <tag>svelte</tag> 后文');
		expect(out).toContain('<tag>svelte</tag>');
		expect(out.match(/<tag>svelte<\/tag>/g)).toHaveLength(1);
	});

	it('roundtrips the five alert types with an optional title, normalizing case', () => {
		for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
			const out = roundtrip(`> [!${type}] 自定义标题\n> 正文内容`);
			// the canonical saved form is the spec's upper-case marker
			expect(out).toContain(`> [!${type}] 自定义标题`);
			expect(out).toContain('> 正文内容');
		}
	});

	it('keeps a nested quote inside the alert body', () => {
		const out = roundtrip('> [!TIP]\n> > 嵌套引用');
		expect(extractAlertMarkdown(out)).toContain('> 嵌套引用');
	});

	it('keeps a non-quote line after the alert (no lazy-continuation swallow)', () => {
		const out = roundtrip('> [!NOTE] 标题\n> 正文\n懒续行');
		expect(out).toContain('懒续行');
		expect(out).toContain('> 正文');
	});

	it('handles an alert at end of input without a terminator', () => {
		const out = roundtrip('> [!NOTE]\n> 结尾内容');
		expect(out).toContain('> [!NOTE]');
		expect(out).toContain('结尾内容');
	});

	it('leaves unknown markers to the plain quote transformer', () => {
		const out = roundtrip('> [!UNKNOWN] 未知');
		expect(out).toContain('> [!UNKNOWN] 未知');
	});

	it('keeps nested lists and headings inside alerts', () => {
		const out = roundtrip('> [!TIP]\n> ### 小节\n>\n> - a\n> - b');
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
		const out = roundtrip('同时使用 <tag>alpha</tag> 与 <tag>beta</tag>');
		expect(out).toContain('<tag>alpha</tag>');
		expect(out).toContain('<tag>beta</tag>');
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

	it('keeps retired alignment directive text as plain text (batch 4b)', () => {
		const out = roundtrip(':::center\n居中的内容\n:::');
		expect(out).toContain(':::center');
		expect(out).toContain('居中的内容');
	});

	it('keeps block content intact when followed by an alert (temp editor reuse)', () => {
		const out = roundtrip('普通段落内容\n\n> [!NOTE]\n> 提示内容');
		expect(out).toContain('普通段落内容');
		expect(out).toContain('> [!NOTE]');
		expect(out).toContain('提示内容');
	});

	it('keeps block content intact when followed by a table (temp editor reuse)', () => {
		const out = roundtrip('普通段落内容\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
		expect(out).toContain('普通段落内容');
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

		// 结构断言:导入必须产出 checklist 节点。核心 TRANSFORMERS 漏掉
		// CHECK_LIST 时,`- [ ] x` 被 UNORDERED_LIST 抢先消费,退化为普通
		// 列表 + 字面 "[ ]" 文本——导出结果恰好仍包含原字符串,上面的
		// toContain 断言区分不了这两种情况,必须直接检查树结构。
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-transformers-checklist-import',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				$convertFromMarkdownString(md, EDITOR_TRANSFORMERS);
			},
			{ discrete: true }
		);
		const json = JSON.stringify(editor.getEditorState().toJSON());
		expect(json).toContain('"listType":"check"');
		expect(json).not.toContain('[ ] 待办事项');
	});

	it('is stable on a second roundtrip for the full feature matrix', () => {
		const md = [
			'# 大标题',
			'',
			'正文 <tag>标签</tag> 与 <sup>上标</sup>',
			'',
			'- [ ] 待办',
			'',
			':::center',
			'居中段落',
			':::',
			'',
			'> [!NOTE]',
			'> 提示内容',
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
		// the core transformer normalizes the nesting order (mark outer, bold inner)
		const out = roundtrip('==**粗体高亮**==');
		expect(out).toBe('**==粗体高亮==**');
	});

	it('keeps plain == untouched in editor roundtrip', () => {
		// the editor does no flanking checks (micromark guarantees them when rendering)
		expect(roundtrip('a == b == c')).toBe('a == b == c');
	});
});

describe('math and footnote nodes (batch B)', () => {
	it('converts $x$ into an inline math node and roundtrips', () => {
		expect(treeTypes('$x$')).toContain('inline-math');
		expect(roundtrip('$x$')).toBe('$x$');
	});

	it('keeps the paren notation on export (no source rewriting)', () => {
		expect(treeTypes('\\(x\\)')).toContain('inline-math');
		expect(roundtrip('\\(x\\)')).toBe('\\(x\\)');
	});

	it('accepts padded math content like micromark and keeps it byte-stable', () => {
		expect(treeTypes('公式 $ x $ 结束')).toContain('inline-math');
		expect(roundtrip('公式 $ x $ 结束')).toBe('公式 $ x $ 结束');
		expect(roundtrip('$$ x $$')).toBe('$$ x $$');
		expect(roundtrip('公式 \\( x \\) 结束')).toBe('公式 \\( x \\) 结束');
	});

	it('converts a standalone $$x$$ paragraph into a block math node', () => {
		expect(treeTypes('$$x$$')).toContain('block-math');
		expect(roundtrip('$$x$$')).toBe('$$x$$');
	});

	it('mirrors the render guards: price-like and glued forms stay literal', () => {
		expect(treeTypes('价格 $5 和 $6 元')).not.toContain('inline-math');
		expect(treeTypes('a$b$')).not.toContain('inline-math');
		expect(treeTypes('a$b$1')).not.toContain('inline-math');
		expect(roundtrip('价格 $5 和 $6 元')).toBe('价格 $5 和 $6 元');
	});

	it('converts footnote refs into a node and keeps the definition line stable', () => {
		expect(treeTypes('正文[^note] 结束')).toContain('footnote-ref');
		expect(treeTypes('[^note]: 定义文本')).not.toContain('footnote-ref');
		expect(roundtrip('正文[^note] 结束\n\n[^note]: 定义文本')).toBe(
			'正文[^note] 结束\n\n[^note]: 定义文本'
		);
	});

	it('converts inline footnotes into a node and roundtrips', () => {
		expect(treeTypes('文末^[行内脚注] 之后')).toContain('footnote-inline');
		expect(roundtrip('文末^[行内脚注] 之后')).toBe('文末^[行内脚注] 之后');
	});

	it('keeps the double-backslash paren form literal', () => {
		expect(treeTypes('\\\\(x\\\\)')).not.toContain('inline-math');
	});

	it('leaves escaped math and footnote openers literal', () => {
		expect(treeTypes('\\$x\\$')).not.toContain('inline-math');
		expect(treeTypes('\\[^a]')).not.toContain('footnote-ref');
	});
});

describe('live-form trigger regexes (batch B)', () => {
	it('pins math live forms and their guards', () => {
		expect(mathInlineTransformer.regExp?.test('$x$')).toBe(true);
		expect(mathInlineTransformer.regExp?.test('价格 $5 元')).toBe(false);
		expect(mathParenTransformer.regExp?.test('\\(x\\)')).toBe(true);
	});

	it('pins footnote live forms and the escape guard', () => {
		expect(footnoteRefTransformer.regExp?.test('[^a]')).toBe(true);
		expect(footnoteRefTransformer.regExp?.test('\\[^a]')).toBe(false);
		expect(footnoteInlineTransformer.regExp?.test('^[行内]')).toBe(true);
		expect(footnoteInlineTransformer.regExp?.test('x^[行内]')).toBe(true);
	});
});

describe('embed cards and mermaid in the editor (batch C)', () => {
	it('converts a provider URL image into an embed card node', () => {
		const md = '![example-org/example-repo](https://github.com/example-org/example-repo)';
		expect(treeTypes(md)).toContain('embed');
		expect(roundtrip(md)).toBe(md);
	});

	it('keeps tail attributes on an embed card through the roundtrip', () => {
		const md = '![t](https://example.com/x) {width=100}';
		expect(treeTypes(md)).toContain('embed');
		expect(roundtrip(md)).toBe(md);
	});

	it('converts an unmatched non-image URL into a generic embed card', () => {
		expect(treeTypes('![示例站点](https://example.com/some/page)')).toContain('embed');
	});

	it('keeps real images as image nodes', () => {
		const md = '![图](https://example.com/a.png)';
		expect(treeTypes(md)).toContain('image');
		expect(treeTypes(md)).not.toContain('embed');
	});

	it('converts a mermaid fence into a mermaid node and roundtrips', () => {
		const md = ['```mermaid', 'flowchart LR', '	A --> B', '```'].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('mermaid');
		expect(roundtrip(md)).toBe(md);
	});

	it('imports unterminated mermaid fences as diagrams (render pipeline parity)', () => {
		const md = ['```mermaid', 'flowchart LR', '	A --> B'].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('mermaid');
	});

	it('keeps other fenced languages as code nodes', () => {
		const md = ['```ts', 'const x = 1;', '```'].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('code');
		expect(treeTypes(md)).not.toContain('mermaid');
	});
});

describe('containers in the editor (batch D)', () => {
	it('converts a details directive into a details node and roundtrips', () => {
		const md = [':::details{summary="更多信息"}', '详情内容', ':::'].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('details');
		expect(roundtrip(md)).toBe(md);
	});

	it('converts the spoiler sugar into a details node and roundtrips', () => {
		const md = [':::spoiler{label="点我"}', '剧透内容', ':::'].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('details');
		expect(roundtrip(md)).toBe(md);
	});

	it('keeps the open flag and the default summary through the roundtrip', () => {
		const md = [':::details{summary="展开" open}', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
		const bare = [':::details', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(bare)).toBe(bare);
		expect(treeTypes(bare)).toContain('details');
	});

	it('converts a tabs block with tab children and roundtrips', () => {
		const md = [
			'::::tabs',
			':::tab{label="第一个标签"}',
			'第一页内容。',
			':::',
			':::tab{label="第二个标签"}',
			'第二页内容。',
			':::',
			'::::'
		].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('tabs');
		expect(roundtrip(md)).toBe(md);
	});

	it('does not invent an open flag from a quoted value (batch D fix)', () => {
		const md = [':::details{summary="See open door"}', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
	});

	it('treats any open form as open and keeps the source bytes (batch D fix)', () => {
		const md = [':::details{summary="x" open=true}', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
	});

	it('preserves out-of-range and unknown grid keys (batch D fix)', () => {
		const md = [':::grid{cols=99 gap=7 bogus=9}', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
	});

	it('preserves unknown details keys (batch D fix)', () => {
		const md = [':::details{label="甲"}', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
	});

	it('accepts a grid without braces (batch D fix)', () => {
		const md = [':::grid', '内容', ':::'].join(String.fromCharCode(10));
		expect(roundtrip(md)).toBe(md);
	});

	it('keeps both nested containers in one alert body (batch D fix)', () => {
		const md = [
			'> [!NOTE] 标题',
			'> :::grid{cols=2}',
			'> 甲',
			'> :::',
			'> :::grid{cols=3}',
			'> 乙',
			'> :::'
		].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('alert');
		const out = roundtrip(md);
		expect(out).toContain(':::grid{cols=2}');
		expect(out).toContain(':::grid{cols=3}');
		expect(out).toContain('甲');
		expect(out).toContain('乙');
	});

	it('converts a grid block with parameters and roundtrips', () => {
		const md = [
			':::grid{cols=2 gap=8 layout=grid type=images}',
			'![图一](https://example.com/a.png)',
			'![图二](https://example.com/b.png)',
			':::'
		].join(String.fromCharCode(10));
		expect(treeTypes(md)).toContain('grid');
		expect(roundtrip(md)).toBe(md);
	});

	it('nests a container inside an alert body through the reentrant path', () => {
		const md = ['> [!NOTE] 标题', '> :::grid{cols=2}', '> 内容', '> :::'].join(
			String.fromCharCode(10)
		);
		expect(treeTypes(md)).toContain('alert');
		expect(roundtrip(md)).toBe(md);
	});

	it('keeps the legacy space dialect literal (render parity)', () => {
		const legacyGrid = [':::grid {cols=2}', '内容', ':::'].join(String.fromCharCode(10));
		expect(treeTypes(legacyGrid)).not.toContain('grid');
		expect(roundtrip(legacyGrid)).toBe(legacyGrid);
		const legacyDetails = [':::details summary="旧形态"', '内容', ':::'].join(
			String.fromCharCode(10)
		);
		expect(treeTypes(legacyDetails)).not.toContain('details');
	});

	it('keeps retired or unknown directives literal', () => {
		const center = [':::center', '居中内容', ':::'].join(String.fromCharCode(10));
		expect(treeTypes(center)).not.toContain('details');
		expect(roundtrip(center)).toBe(center);
		const unknown = [':::whatever', '内容', ':::'].join(String.fromCharCode(10));
		expect(treeTypes(unknown)).not.toContain('details');
	});
});

describe('import escape symmetry (fixpoint)', () => {
	/** The editor text after the production import path (convert + unescape). */
	function textOf(markdown: string): string {
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-fixpoint',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				$convertFromMarkdownString(normalizeChecklistMarkers(markdown), EDITOR_TRANSFORMERS);
				$unescapeImportedText();
			},
			{ discrete: true }
		);
		return editor.getEditorState().read(() => $getRoot().getTextContent());
	}

	it('shows escaped punctuation unescaped in the editor text', () => {
		expect(textOf('a\\_b')).toContain('a_b');
		expect(textOf('a\\_b')).not.toContain('\\_');
	});

	it('reaches a fixpoint after the first export', () => {
		for (const src of ['a_b', 'a*b', 'lead $$int_0^1$$ tail', 'snake_case word']) {
			const first = roundtrip(src);
			const second = roundtrip(first);
			expect(second, `no fixpoint for ${src}`).toBe(first);
		}
	});

	it('preserves the uppercase [X] checked state (marker normalized to [x])', () => {
		// the core compares match[3] === 'x' case-sensitively, so [X] would
		// silently import as unchecked; we lowercase list markers on import —
		// the CHECKED STATE survives, only the marker style is canonicalized
		const once = roundtrip('- [X] upper');
		expect(once).toBe('- [x] upper');
		expect(roundtrip(once)).toBe(once);
	});

	it('preserves 2-space nested lists on roundtrip (upstream ≥0.51 keeps nesting)', () => {
		// Up to 0.50 the markdown import flattened a 2-space nested list
		// (LIST_INDENT_SIZE=4 on import) and the export emitted the flat form.
		// 0.51 keeps the nesting and canonicalizes the marker column to the
		// 4-space LIST_INDENT_SIZE on export; the roundtrip is then stable.
		const src = '- a' + String.fromCharCode(10) + '  - b';
		const once = roundtrip(src);
		expect(once).toBe('- a' + String.fromCharCode(10) + '    - b');
		expect(roundtrip(once)).toBe(once);
	});

	it('keeps code spans stable (fixpoint, upstream normalizes once)', () => {
		// The core unescapes formatted text on import (the markdown importText
		// path ends with unescapeText), so a backslash inside a codespan is
		// normalized away once by upstream and then stays stable. Assert the
		// fixpoint — byte-identity is not reachable without patching the core.
		const md = '`a\\_b`';
		const first = roundtrip(md);
		expect(roundtrip(first)).toBe(first);
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

	it('re-emits the image tail attribute on export', () => {
		const out = roundtrip('![a](https://example.com/a.png) {width=480 height=320}');
		expect(out).toContain('![a](https://example.com/a.png) {width=480 height=320}');
	});

	it('imports a tail-attributed image line as an ImageNode', () => {
		const editor: LexicalEditor = createEditor({
			namespace: 'markdown-transformers-test',
			nodes: EDITOR_NODES,
			onError: (error: Error) => {
				throw error;
			}
		});
		editor.update(
			() => {
				$convertFromMarkdownString(
					'![a](https://example.com/a.png) {width=480}',
					EDITOR_TRANSFORMERS
				);
			},
			{ discrete: true }
		);
		editor.getEditorState().read(() => {
			const first = $getRoot().getFirstChild();
			expect($isImageNode(first)).toBe(true);
			const serialized: SerializedImageNode = (first as ImageNode).exportJSON();
			expect(serialized.tailAttrs).toBe('width=480');
		});
	});
});

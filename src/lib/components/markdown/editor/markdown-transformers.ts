/**
 * 编辑器自定义 Markdown Transformer 集合。
 *
 * Lexical 的 markdown 往返（$convertToMarkdownString / $convertFromMarkdownString）
 * 只认识已注册 Transformer 的节点——缺少 Transformer 的自定义节点在往返中会丢失。
 *
 * 本模块为 TagNode（`<tag>x</tag>`）与 AlertNode（`> [!NOTE] …`）提供：
 * - 导出（Lexical 树 → Markdown）
 * - 导入（Markdown → Lexical 树）
 * - Alert 嵌套内容的 editorState JSON ↔ Markdown 互转助手
 *
 * 参考：
 * - https://lexical.dev/docs/packages/lexical-markdown
 * - @lexical/markdown@0.46.0 MultilineElementTransformer（regExpStart/regExpEnd/linesInBetween）
 */
import {
	createEditor,
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$isTextNode,
	type LexicalEditor,
	type LexicalNode,
	type SerializedLexicalNode
} from 'lexical';
import {
	TRANSFORMERS,
	CHECK_LIST,
	isTableRowDivider,
	$convertFromMarkdownString,
	$convertToMarkdownString,
	type ElementTransformer,
	type MultilineElementTransformer,
	type TextMatchTransformer,
	type Transformer
} from '@lexical/markdown';
import {
	HorizontalRuleNode,
	$createHorizontalRuleNode,
	$isHorizontalRuleNode
} from '@lexical/extension';
import {
	TableNode,
	TableRowNode,
	TableCellNode,
	TableCellHeaderStates,
	$createTableNode,
	$createTableRowNode,
	$createTableCellNode,
	$isTableNode,
	$isTableRowNode,
	$isTableCellNode
} from '@lexical/table';
import {
	ImageNode,
	$createImageNode,
	$isImageNode
} from '$lib/components/markdown/image/image-node';
import { TagNode, $createTagNode, $isTagNode } from '$lib/components/markdown/tag/tag-node';
import {
	SpoilerNode,
	$createSpoilerNode,
	$isSpoilerNode
} from '$lib/components/markdown/spoiler/spoiler-node';
import {
	MentionNode,
	$createMentionNode,
	$isMentionNode
} from '$lib/components/markdown/mention/mention-node';
import {
	AlertNode,
	$createAlertNode,
	$isAlertNode
} from '$lib/components/markdown/alert/alert-node';
import {
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer
} from '$lib/components/markdown/math/math-transformers';
import {
	footnoteRefTransformer,
	footnoteInlineTransformer
} from '$lib/components/markdown/footnote/footnote-transformers';
import { decideImage } from '$lib/components/markdown/embed/resolve';
import { $createEmbedNode } from '$lib/components/markdown/embed/embed-node';
import {
	embedTransformer,
	mermaidTransformer
} from '$lib/components/markdown/editor/embed-mermaid-transformers';
import { detailsTransformer } from '$lib/components/markdown/details/details-transformers';
import {
	tabsTransformer,
	gridTransformer
} from '$lib/components/markdown/grid/container-transformers';
import { parseAlertMarker } from '$lib/components/markdown/alert/alert-types';
import { EDITOR_THEME, NESTED_EDITOR_NODES } from '$lib/components/markdown/editor/editor-shared';

// ── Tag: `<tag>x</tag>` ↔ TagNode (4.5 whitelist element) ──

/**
 * Inline tag transformer.
 *
 * Spec v0.3 retires the `#content#` syntax (the "explicitly absent" list of
 * spec 2) in favour of the 4.5 whitelist `<tag>` inline element; the render
 * side keeps it through the raw-HTML whitelist and the site layer (L3) styles
 * it with element selectors.
 */
export const tagTransformer: TextMatchTransformer = {
	dependencies: [TagNode],
	importRegExp: /<tag>([^<]+)<\/tag>/,
	regExp: /<tag>([^<]+)<\/tag>$/,
	trigger: '>',
	replace: (textNode, match) => {
		// inline code binds tighter than text-match transformers (4.2)
		if (textNode.hasFormat('code')) return;
		const tagNode = $createTagNode(match[1]);
		textNode.replace(tagNode);
	},
	export: (node) => {
		if (!$isTagNode(node)) return null;
		return `<tag>${node.getTextContent()}</tag>`;
	},
	type: 'text-match'
};

// ── Spoiler: `||x||` ↔ SpoilerNode (2 #6) ──

/** Import form: run-guarded (no `|`/escape adjacent), non-space flanking. */
const SPOILER_IMPORT = /(?<![|\\])[|]{2}(?=\S)([^|]*?\S)[|]{2}(?![|])/;
const SPOILER_LIVE = /(?<![|\\])[|]{2}(?=\S)([^|]*?\S)[|]{2}(?![|])$/;

export const spoilerTransformer: TextMatchTransformer = {
	dependencies: [SpoilerNode],
	importRegExp: SPOILER_IMPORT,
	regExp: SPOILER_LIVE,
	trigger: '|',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		// Inverse of exportFormat's escaping, keeping the round trip stable.
		const inner = match[1].replace(/\\([*_`~\\])/g, '$1');
		const node = $createSpoilerNode(inner);
		node.setFormat(textNode.getFormat());
		textNode.replace(node);
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isSpoilerNode(node)) return null;
		// Canonical serialization: exportFormat applies the core's escaping,
		// code-span delimiters and nest order, matching what the render side
		// expects (batch A review, F3). Formatted spoilers still re-import
		// without their formats — registered, see batch-A review register.
		return '||' + exportFormat(node, node.getTextContent()) + '||';
	},
	type: 'text-match'
};

// ── Mention: `@gh:user` ↔ MentionNode (2 #4) ──

/** Boundary: line start, whitespace or punctuation (render-side mirror). The
 * escape guard intentionally over-blocks a spaced backslash (`\ \@`) — registered. */
const MENTION_IMPORT = /(?<!\\)(?<=^|[\s\p{P}\p{S}])@(?:gh|tw|tg):[A-Za-z0-9_]{1,40}/u;
/** Live form commits on the terminator space, which replace() re-inserts. */
const MENTION_LIVE = /(?<!\\)(?<=^|[\s\p{P}\p{S}])@(?:gh|tw|tg):[A-Za-z0-9_]{1,40} $/u;

export const mentionTransformer: TextMatchTransformer = {
	dependencies: [MentionNode],
	importRegExp: MENTION_IMPORT,
	regExp: MENTION_LIVE,
	trigger: ' ',
	replace: (textNode, match) => {
		if (textNode.hasFormat('code')) return;
		// the live form commits on a space; the import form must not gain one
		const terminator = match[0].endsWith(' ') ? ' ' : '';
		const node = $createMentionNode(match[0].trimEnd());
		textNode.replace(node);
		if (terminator) node.insertAfter($createTextNode(terminator));
	},
	export: (node) => ($isMentionNode(node) ? node.getTextContent() : null),
	type: 'text-match'
};

// ── HR：`---` / `***` / `___` ↔ HorizontalRuleNode ──

/**
 * 水平分割线 Transformer。
 *
 * 0.46 的 @lexical/markdown 不再内置 HR transformer（HorizontalRuleNode 的
 * getTextContent() 返回 '\n'），缺失时 $convertToMarkdownString 会静默丢弃
 * 分割线，导致保存后 `---` 消失。仿上游 playground 的 HR transformer 实现。
 */
export const hrTransformer: ElementTransformer = {
	dependencies: [HorizontalRuleNode],
	export: (node) => {
		if (!$isHorizontalRuleNode(node)) return null;
		return '---';
	},
	regExp: /^(---|\*\*\*|___)\s?$/,
	replace: (parentNode, _children, _match, isImport) => {
		void isImport;
		const hr = $createHorizontalRuleNode();
		parentNode.replace(hr);
		// 打字路径且分割线位于文末时，补一个空段落承接光标
		if (!isImport && !hr.getNextSibling()) {
			const paragraph = $createParagraphNode();
			hr.insertAfter(paragraph);
			paragraph.select();
		}
	},
	type: 'element'
};

// ── Image：`![alt](src)` ↔ ImageNode ──

/**
 * 图片 Transformer（整行独立图片 ↔ 块级 ImageNode）。
 *
 * 已知限制（有意为之）：
 * - 仅支持块级独立图片（`![...](...)` 独占一行）；段落内联的
 *   `![...](...)` 文本保持原样（渲染管线会转为 <img>）
 * - alt 含 `]` 或 src 含 `)` 时往返会失真（罕见场景，不转义）
 */
export const imageTransformer: ElementTransformer = {
	dependencies: [ImageNode],
	export: (node) => {
		if (!$isImageNode(node)) return null;
		const tail = node.__tailAttrs ? ` {${node.__tailAttrs}}` : '';
		return `![${node.__alt}](${node.__src})${tail}`;
	},
	regExp: /^!\[([^\]]*)\]\(([^)\s]+)\)(?:\s+\{([^}]*)\})?$/,
	replace: (parentNode, _children, match, isImport) => {
		const alt = match[1] ?? '';
		const src = match[2] ?? '';
		const tail = (match[3] ?? '').trim();
		const decision = decideImage({ url: src, tailAttrs: tail || undefined });
		if (decision.kind === 'embed') {
			// spec 3.4: a provider or generic card instead of an image
			const embed = $createEmbedNode(src, alt, decision.provider, tail);
			parentNode.replace(embed);
			// no caret nudge: this transformer only ever runs on import (the same
			// pre-existing characteristic as the image path below)
			return;
		}
		const image = $createImageNode(src, alt, tail);
		parentNode.replace(image);
		// 打字路径且图片位于文末时，补一个空段落承接光标
		if (!isImport && !image.getNextSibling()) {
			const paragraph = $createParagraphNode();
			image.insertAfter(paragraph);
			paragraph.select();
		}
	},
	type: 'element'
};

// ── Table：GFM pipe 表格 ↔ TableNode ──

/** 一行 pipe 表格（如 `| a | b |`） */
const TABLE_ROW_REGEX = /^\s*\|.*\|\s*$/;

/** 解析一行 pipe 表格为单元格文本数组，处理 `\|` 转义 */
function parseTableRow(line: string): string[] {
	const content = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells: string[] = [];
	let current = '';
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === '\\' && content[i + 1] === '|') {
			current += '|';
			i++;
		} else if (ch === '|') {
			cells.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

/** 单元格 → 单行 markdown（保留行内格式，折叠换行，转义 `|`） */
function tableCellToMarkdown(
	cell: TableCellNode,
	exportChildren: (node: TableCellNode) => string
): string {
	return exportChildren(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * 单元格行内 markdown → 节点规格树（temp editor 解析）。
 *
 * 表格导入走 handleImportAfterStartMatch 自定义路径，不经过行内
 * transformer 管线；单元格文本若直接建纯文本节点，粗体/行内代码/链接
 * 等行内语法会保持字面。因此借 temp editor 完整解析，
 * 再按规格树在真实编辑器中重建（跨编辑器不传递节点实例）。
 */
function inlineMarkdownToSpecs(markdown: string): SpecNode[] {
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			try {
				$convertFromMarkdownString(normalizeChecklistMarkers(markdown), NESTED_EDITOR_TRANSFORMERS);
				$unescapeImportedText();
			} catch {
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(markdown));
				root.append(p);
			}
		},
		{ discrete: true }
	);
	return editor.getEditorState().read(() => {
		const first = $getRoot().getChildren()[0];
		if (!$isElementNode(first)) return [];
		return first.getChildren().map(specTreeFromNode);
	});
}

/**
 * GFM pipe 表格 Transformer。
 *
 * - 导入：0.46 新增的 handleImportAfterStartMatch 钩子——header 行起、
 *   连续 `|` 行止；必须有 `| --- |` 分隔行才视为表格（否则回落为普通文本）。
 *   单元格行内语法（粗体/斜体/行内代码/链接）经 temp editor 完整解析。
 * - 导出：遍历行列拼 pipe 表格，首行后补分隔行；单元格用 exportChildren
 *   保留行内格式（粗体/斜体/行内代码等），多段落折叠为单行。
 *
 * 已知限制：列对齐（`:---:`）、跨行/跨列合并不参与 markdown 往返；
 * 表头状态亦不持久——GFM pipe 语法必须首行后跟分隔行才能识别为表格，
 * 因此导出无条件补 `| --- |`、导入固定首行为表头，TableCellMenu 的
 * "切换表头"在保存/重载后会还原为首行表头（文本内容不受影响）。
 */
export const tableTransformer: MultilineElementTransformer = {
	dependencies: [TableNode, TableRowNode, TableCellNode],
	regExpStart: TABLE_ROW_REGEX,
	regExpEnd: { regExp: /^(?!\s*\|)/, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		// 第二行必须是分隔行，否则不是表格（返回 null 交给后续 transformer）
		const dividerLine = (lines[startLineIndex + 1] ?? '').trim();
		if (!isTableRowDivider(dividerLine)) return null;

		// 收集连续表格行（含 header 与分隔行）
		const rawRows: string[] = [lines[startLineIndex], lines[startLineIndex + 1]];
		let i = startLineIndex + 2;
		while (i < lines.length && TABLE_ROW_REGEX.test(lines[i])) {
			rawRows.push(lines[i]);
			i++;
		}

		const table = $createTableNode();
		rawRows.forEach((line, rowIndex) => {
			if (rowIndex === 1) return; // 分隔行不生成数据行
			const row = $createTableRowNode();
			for (const text of parseTableRow(line)) {
				const cell = $createTableCellNode(
					rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS
				);
				const paragraph = $createParagraphNode();
				if (text) {
					// 行内 markdown（粗体/斜体/行内代码/链接）完整解析
					for (const spec of inlineMarkdownToSpecs(text)) {
						paragraph.append(nodeFromSpecTree(spec));
					}
				}
				cell.append(paragraph);
				row.append(cell);
			}
			table.append(row);
		});
		rootNode.append(table);
		// 返回最后消费的行下标
		return [true, i - 1];
	},
	replace: () => {
		// 导入由 handleImportAfterStartMatch 处理；打字快捷输入不转换表格
		return false;
	},
	export: (node, exportChildren) => {
		if (!$isTableNode(node)) return null;
		const rows = node.getChildren().filter($isTableRowNode);
		if (rows.length === 0) return null;
		const lines: string[] = [];
		rows.forEach((row, rowIndex) => {
			const cells = row.getChildren().filter($isTableCellNode);
			const line = `| ${cells.map((c) => tableCellToMarkdown(c, exportChildren)).join(' | ')} |`;
			lines.push(line);
			if (rowIndex === 0) {
				lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
			}
		});
		return lines.join('\n');
	},
	type: 'multiline-element'
};

// ── Alert: `> [!NOTE] title …` → AlertNode(spec §3.1)──

/** A line opening a blockquote alert; the marker itself is parsed in the handler. */
const ALERT_START_REGEX = /^>\s?\[!/;
/** A line that is not part of the blockquote ends the alert. */
const ALERT_END_REGEX = /^(?!>)/;
/** Prefix stripped from every body line before the nested editor parses it. */
const QUOTE_PREFIX_REGEX = /^>\s?/;

/**
 * 嵌套编辑器内容使用的 transformer 子集。
 *
 * 嵌套编辑器不注册 TagNode/AlertNode（防无限嵌套），
 * 因此 alert 内部的 markdown 使用标准 transformer 解析。
 * HR 节点已注册（见 NESTED_EDITOR_NODES），补上其 transformer 保证 `---` 往返。
 */
/**
 * Counterpart of the core markdown export's safety escaping: the exporter
 * escapes markdown-significant punctuation (`a_b` -> `a\_b`) but the core's
 * plain-text import path never unescapes it, so repeated save/load cycles
 * re-escape the accumulated backslashes (no fixpoint). This mirrors the core's
 * own unescapeText rule (MarkdownImport text path) and skips code so literal
 * backslashes inside code spans/blocks stay intact.
 */
/**
 * The core's CHECK_LIST regex matches `[X]` case-insensitively
 * (CHECKLIST_REGEX has /i) but its checked-state comparison is
 * `match[3] === 'x'` — case-sensitive — so an uppercase box silently
 * imports as unchecked and the next export rewrites `- [X]` to
 * `- [ ]`. Lowercase the marker on list lines before importing.
 */
export function normalizeChecklistMarkers(markdown: string): string {
	// No regex here on purpose: the core's CHECK_LIST shape needs a
	// whitespace class that is awkward to spell in a literal and easy to
	// mangle across tooling layers; plain string ops are exact.
	const lineBreak = String.fromCharCode(10);
	const upper = String.fromCharCode(91) + 'X' + String.fromCharCode(93);
	const lower = String.fromCharCode(91) + 'x' + String.fromCharCode(93);
	return markdown
		.split(lineBreak)
		.map((line) => {
			const trimmed = line.trimStart();
			const hasMarker =
				trimmed.startsWith('- ' + upper) ||
				trimmed.startsWith('* ' + upper) ||
				trimmed.startsWith('+ ' + upper);
			if (!hasMarker) return line;
			const at = line.indexOf(upper);
			if (at === -1) return line;
			return line.slice(0, at) + lower + line.slice(at + upper.length);
		})
		.join(lineBreak);
}

export function $unescapeImportedText(): void {
	const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
	for (const node of $getRoot().getAllTextNodes()) {
		// Skip inline code (a text node with the 'code' format bit) and code
		// blocks/code-highlight children: backslash escapes are literal there
		// on the render side, so they must stay literal here too.
		if (node.hasFormat('code')) continue;
		const parent = node.getParent();
		if (parent && (parent.getType() === 'code' || parent.getType() === 'code-highlight')) continue;
		const text = node.getTextContent();
		const next = unescape(text);
		if (next !== text) node.setTextContent(next);
	}
}

export const NESTED_EDITOR_TRANSFORMERS: Transformer[] = [
	// 自定义 transformer 必须先于核心 TRANSFORMERS(导入逐个尝试,靠前者
	// 优先):CHECK_LIST 排在 ...TRANSFORMERS 之后会被 UNORDERED_LIST 抢先
	// 消费 `- [ ]`(等于没修);mermaidTransformer 同理会被核心 CODE 抢先,
	// 容器正文内的 ```mermaid 会导入成普通代码块。
	CHECK_LIST,
	mermaidTransformer,
	...TRANSFORMERS,
	hrTransformer,
	spoilerTransformer,
	mentionTransformer,
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer,
	footnoteRefTransformer,
	footnoteInlineTransformer,
	embedTransformer,
	detailsTransformer,
	tabsTransformer,
	gridTransformer
];

// 复用的临时嵌套编辑器（headless，无 DOM）。
// 每次导出新建编辑器开销过大，这里模块级缓存一个实例（见设计文档 §8 升级点标注）。
let nestedTempEditor: LexicalEditor | null = null;

function getNestedTempEditor(): LexicalEditor {
	if (!nestedTempEditor) {
		nestedTempEditor = createEditor({
			namespace: 'markdown-nested-temp',
			nodes: NESTED_EDITOR_NODES,
			theme: EDITOR_THEME,
			onError: (error: Error) => console.error('Nested temp editor error:', error)
		});
	}
	return nestedTempEditor;
}

/** Markdown → Alert 嵌套编辑器 editorState JSON（解析失败时降级为纯文本段落） */
/** Guards reentrancy: a container transformer runs this while the shared
 * temp editor is mid-update, which would swallow nested fences. */
let nestedTempDepth = 0;

export function markdownToAlertJson(markdown: string): string {
	const editor =
		nestedTempDepth > 0
			? createEditor({
					namespace: 'markdown-nested-oneoff',
					nodes: NESTED_EDITOR_NODES,
					theme: EDITOR_THEME,
					onError: (error: Error) => console.error('One-off nested editor error:', error)
				})
			: getNestedTempEditor();
	nestedTempDepth += 1;
	try {
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				try {
					$convertFromMarkdownString(
						normalizeChecklistMarkers(markdown),
						NESTED_EDITOR_TRANSFORMERS
					);
					$unescapeImportedText();
				} catch {
					root.clear();
					const p = $createParagraphNode();
					p.append($createTextNode(markdown));
					root.append(p);
				}
			},
			{ discrete: true }
		);
		return JSON.stringify(editor.getEditorState().toJSON());
	} finally {
		nestedTempDepth -= 1;
	}
}

/** Alert 嵌套编辑器 editorState JSON → Markdown（JSON 非法时返回空串） */
export function alertJsonToMarkdown(json: string): string {
	if (!json?.trim()) return '';
	const editor = getNestedTempEditor();
	try {
		const state = editor.parseEditorState(json);
		let markdown = '';
		state.read(() => {
			markdown = $convertToMarkdownString(NESTED_EDITOR_TRANSFORMERS);
		});
		return markdown;
	} catch {
		return '';
	}
}

/**
 * Alert Transformer（多行块，spec §3.1 的 blockquote 载体）。
 *
 * - 导入走 handleImportAfterStartMatch：marker 行起、连续 `>` 行止；停止时
 *   **不消费**那条非 `>` 行，它在文档里保持为独立块。注意与渲染端的分歧：
 *   CommonMark 懒续行会把该行并入引用（成为告警正文），编辑器则留在块外——
 *   两侧都不丢内容，但归属不同。
 *   正文（剥 `> ` 前缀）经嵌套编辑器 JSON 往返；标题存 AlertNode.__title，
 *   导出时回到 marker 行。
 * - 导出：`> [!type] title` + 逐行 `> ` 前缀。
 *
 * 已知限制：alert 内不再支持嵌套 alert（嵌套编辑器不注册本 transformer），
 * 与编辑器「防无限嵌套」约定一致。
 */
export const alertTransformer: MultilineElementTransformer = {
	dependencies: [AlertNode],
	regExpStart: ALERT_START_REGEX,
	regExpEnd: { regExp: ALERT_END_REGEX, optional: true },
	handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
		const parsed = parseAlertMarker((lines[startLineIndex] ?? '').replace(QUOTE_PREFIX_REGEX, ''));
		if (!parsed) return null; // unknown marker → the core quote transformer takes it
		const { type } = parsed;
		const title = parsed.rest.trim();
		const bodyLines: string[] = [];
		let i = startLineIndex + 1;
		while (i < lines.length && lines[i].startsWith('>')) {
			bodyLines.push(lines[i].replace(QUOTE_PREFIX_REGEX, ''));
			i++;
		}
		rootNode.append(
			$createAlertNode(type, markdownToAlertJson(bodyLines.join('\n').trim()), title)
		);
		// Return the last consumed line; the terminating line stays in the document.
		return [true, i - 1];
	},
	replace: () => {
		// Import is handled by handleImportAfterStartMatch; typing shortcuts do not
		// create alerts (multi-line blocks need an explicit insert).
		return false;
	},
	export: (node) => {
		if (!$isAlertNode(node)) return null;
		const header = `> [!${node.__alertType.toUpperCase()}]${node.__title ? ` ${node.__title}` : ''}`;
		const inner = alertJsonToMarkdown(node.__jsonContent);
		if (!inner) return header;
		const body = inner
			.split('\n')
			.map((line) => (line ? `> ${line}` : '>'))
			.join('\n');
		return `${header}\n${body}`;
	},
	type: 'multiline-element'
};

// ── Spec-tree transfer helpers (shared by the spec-based transformers) ──

/**
 * 跨编辑器节点传输的中间表示（纯 JSON 数据）。
 * 节点实例不能跨编辑器复用，也无法在 read 上下文中创建——
 * 因此 temp editor 侧只采集 (class, json) 规格树，
 * 真实节点在目标编辑器的 update 上下文中按规格重建。
 */
interface SpecNode {
	klass: typeof LexicalNode;
	json: SerializedLexicalNode;
	children: SpecNode[];
}

function specTreeFromNode(node: LexicalNode): SpecNode {
	return {
		klass: node.constructor as typeof LexicalNode,
		json: node.exportJSON(),
		children: $isElementNode(node) ? node.getChildren().map(specTreeFromNode) : []
	};
}

function nodeFromSpecTree(spec: SpecNode): LexicalNode {
	const clone = spec.klass.importJSON(spec.json);
	if ($isElementNode(clone) && spec.children.length > 0) {
		clone.append(...spec.children.map(nodeFromSpecTree));
	}
	return clone;
}

// ── Sup/Sub：`<sup>x</sup>` / `<sub>x</sub>` ↔ 上标/下标格式 ──

/**
 * 上标/下标 Transformer（行内 HTML 语法往返）。
 *
 * markdown 无原生上下标语法（`~x~` 与 GFM 删除线冲突），采用行内 HTML：
 * 渲染管线 remarkRehype(allowDangerousHtml) + rehype-raw 已支持，
 * rehype-sanitize 默认放行 sup/sub 标签（服务端与客户端管线均已核实）。
 */
export const superscriptTransformer: TextMatchTransformer = {
	dependencies: [],
	importRegExp: /<sup>(.+?)<\/sup>/,
	regExp: /<sup>(.+?)<\/sup>$/,
	replace: (textNode, match) => {
		// importFoundTextMatchTransformer 已将 textNode 切分为精确匹配段
		textNode.setTextContent(match[1] ?? '');
		textNode.setFormat('superscript');
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isTextNode(node) || !node.hasFormat('superscript')) return null;
		// exportFormat 保留节点上其余行内格式（如 <sup>**x**</sup>）
		return `<sup>${exportFormat(node, node.getTextContent())}</sup>`;
	},
	trigger: '>',
	type: 'text-match'
};

export const subscriptTransformer: TextMatchTransformer = {
	dependencies: [],
	importRegExp: /<sub>(.+?)<\/sub>/,
	regExp: /<sub>(.+?)<\/sub>$/,
	replace: (textNode, match) => {
		textNode.setTextContent(match[1] ?? '');
		textNode.setFormat('subscript');
	},
	export: (node, _exportChildren, exportFormat) => {
		if (!$isTextNode(node) || !node.hasFormat('subscript')) return null;
		return `<sub>${exportFormat(node, node.getTextContent())}</sub>`;
	},
	trigger: '>',
	type: 'text-match'
};

// ── Mark: `==x==` ↔ highlight format (spec §2 #5) ──
// No custom transformer needed: the core TRANSFORMERS in @lexical/markdown 0.46
// already ship the HIGHLIGHT text format (`==` ↔ highlight) — import, export and
// flanking included; the render side uses remark-mark (micromark attention).

// ── 聚合 ──

/**
 * 编辑器完整 transformer 列表：核心语法 + Tag + Alert + HR + Image + Table
 * + Sup/Sub。
 *
 * 顺序约定：自定义 transformer 在前（multiline 导入逐 transformer 尝试，
 * text-match 导出逐 transformer 尝试，靠前者优先），核心 TRANSFORMERS 在后。
 */
export const EDITOR_TRANSFORMERS: Transformer[] = [
	tagTransformer,
	spoilerTransformer,
	mentionTransformer,
	alertTransformer,
	hrTransformer,
	imageTransformer,
	tableTransformer,
	superscriptTransformer,
	subscriptTransformer,
	mathInlineTransformer,
	mathParenTransformer,
	mathBlockTransformer,
	footnoteRefTransformer,
	footnoteInlineTransformer,
	embedTransformer,
	mermaidTransformer,
	detailsTransformer,
	tabsTransformer,
	gridTransformer,
	// 0.46 核心导出了 CHECK_LIST 但没有把它放进 TRANSFORMERS——缺失时
	// `- [ ] x` 会被 UNORDERED_LIST 抢先消费，复选框退化为字面 `[ ]` 文本。
	// 须先于 UNORDERED_LIST 尝试，故置于 ...TRANSFORMERS 之前。
	CHECK_LIST,
	...TRANSFORMERS
];

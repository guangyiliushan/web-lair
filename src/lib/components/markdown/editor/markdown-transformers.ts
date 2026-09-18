/**
 * 编辑器自定义 Markdown Transformer 集合。
 *
 * Lexical 的 markdown 往返（$convertToMarkdownString / $convertFromMarkdownString）
 * 只认识已注册 Transformer 的节点——缺少 Transformer 的自定义节点在往返中会丢失。
 *
 * 本模块为 TagNode（`<tag>x</tag>`）与 AlertNode（`:::info ... :::`）提供：
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
	type ElementFormatType,
	type LexicalEditor,
	type LexicalNode,
	type SerializedLexicalNode
} from 'lexical';
import {
	TRANSFORMERS,
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
	AlertNode,
	$createAlertNode,
	$isAlertNode
} from '$lib/components/markdown/alert/alert-node';
import type { AlertType } from '$lib/components/markdown/alert/alert-types';
import { DEFAULT_ALERT_TYPE } from '$lib/components/markdown/alert/alert-types';
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
		const tagNode = $createTagNode(match[1]);
		textNode.replace(tagNode);
	},
	export: (node) => {
		if (!$isTagNode(node)) return null;
		return `<tag>${node.getTextContent()}</tag>`;
	},
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
		return `![${node.__alt}](${node.__src})`;
	},
	regExp: /^!\[([^\]]*)\]\(([^)\s]+)\)$/,
	replace: (parentNode, _children, match, isImport) => {
		const alt = match[1] ?? '';
		const src = match[2] ?? '';
		const image = $createImageNode(src, alt);
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
function inlineMarkdownToSpecs(markdown: string): AlignedNodeSpec[] {
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			try {
				$convertFromMarkdownString(markdown, NESTED_EDITOR_TRANSFORMERS);
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

// ── Alert：`:::info ... :::` → AlertNode ──

/** Alert 容器起始行，如 `:::info` / `:::tip` / `:::warning` */
const ALERT_START_REGEX = /^:::(info|tip|warning)\s*$/;
/** Alert 容器结束行 `:::` */
const ALERT_END_REGEX = /^:::\s*$/;

/**
 * 嵌套编辑器内容使用的 transformer 子集。
 *
 * 嵌套编辑器不注册 TagNode/AlertNode（防无限嵌套），
 * 因此 alert 内部的 markdown 使用标准 transformer 解析。
 * HR 节点已注册（见 NESTED_EDITOR_NODES），补上其 transformer 保证 `---` 往返。
 */
export const NESTED_EDITOR_TRANSFORMERS: Transformer[] = [...TRANSFORMERS, hrTransformer];

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
export function markdownToAlertJson(markdown: string): string {
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			try {
				$convertFromMarkdownString(markdown, NESTED_EDITOR_TRANSFORMERS);
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
 * Alert 容器 Transformer（多行块）。
 *
 * - 导入：`:::info` 行与 `:::` 行之间的内容（linesInBetween）作为 markdown
 *   解析进嵌套编辑器 JSON，生成 AlertNode。
 * - 导出：将嵌套 JSON 反解为 markdown，包回 `:::type ... :::` 围栏。
 *
 * 已知限制：内容中若出现行首 `:::` 会提前终止容器（与代码围栏同理）。
 */
export const alertTransformer: MultilineElementTransformer = {
	dependencies: [AlertNode],
	regExpStart: ALERT_START_REGEX,
	regExpEnd: ALERT_END_REGEX,
	replace: (rootNode, children, startMatch, _endMatch, linesInBetween, isImport) => {
		// 仅处理 markdown 导入；编辑器内打字快捷输入不触发（多行块需要显式插入）
		if (!isImport || children) return false;
		const type = (startMatch[1] ?? DEFAULT_ALERT_TYPE) as AlertType;
		const markdown = (linesInBetween ?? []).join('\n').trim();
		rootNode.append($createAlertNode(type, markdownToAlertJson(markdown)));
	},
	export: (node) => {
		if (!$isAlertNode(node)) return null;
		const inner = alertJsonToMarkdown(node.__jsonContent);
		return `:::${node.__alertType}\n${inner}\n:::`;
	},
	type: 'multiline-element'
};

// ── Align：`:::center ... :::` ↔ 块级对齐格式 ──

/** 支持对齐指令的对齐方式（与 FORMAT_ELEMENT_COMMAND 的对齐值一致） */
const ALIGN_FORMATS: readonly string[] = ['left', 'center', 'right', 'justify'];
const ALIGN_START_REGEX = /^:::(left|center|right|justify)\s*$/;
const ALIGN_END_REGEX = /^:::\s*$/;

/**
 * 跨编辑器节点传输的中间表示（纯 JSON 数据）。
 * 节点实例不能跨编辑器复用，也无法在 read 上下文中创建——
 * 因此 temp editor 侧只采集 (class, json) 规格树，
 * 真实节点在目标编辑器的 update 上下文中按规格重建。
 */
interface AlignedNodeSpec {
	klass: typeof LexicalNode;
	json: SerializedLexicalNode;
	children: AlignedNodeSpec[];
}

function specTreeFromNode(node: LexicalNode): AlignedNodeSpec {
	return {
		klass: node.constructor as typeof LexicalNode,
		json: node.exportJSON(),
		children: $isElementNode(node) ? node.getChildren().map(specTreeFromNode) : []
	};
}

function nodeFromSpecTree(spec: AlignedNodeSpec): LexicalNode {
	const clone = spec.klass.importJSON(spec.json);
	if ($isElementNode(clone) && spec.children.length > 0) {
		clone.append(...spec.children.map(nodeFromSpecTree));
	}
	return clone;
}

/**
 * 解析内部 markdown 为带对齐格式的块规格树序列。
 *
 * 复用嵌套 temp editor（同 markdownToAlertJson 模式）解析并设置对齐格式；
 * 供真实编辑器在 update 上下文中按规格重建节点。
 * 嵌套子块（标题/引用/列表）的语法由 NESTED_EDITOR_TRANSFORMERS 完整解析。
 */
function markdownToAlignedBlockSpecs(markdown: string, align: string): AlignedNodeSpec[] {
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			try {
				$convertFromMarkdownString(markdown, NESTED_EDITOR_TRANSFORMERS);
			} catch {
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(markdown));
				root.append(p);
			}
			for (const child of root.getChildren()) {
				if ($isElementNode(child)) child.setFormat(align as ElementFormatType);
			}
		},
		{ discrete: true }
	);
	// read 上下文只采集 JSON 数据（创建节点在 read 中会被 Lexical 拒绝）
	return editor.getEditorState().read(() => $getRoot().getChildren().map(specTreeFromNode));
}

/**
 * 单个块节点 → 内部 markdown（temp editor 全量导出，保留标题/引用/列表语法）。
 *
 * 关键：必须先在**真实编辑器的 read 上下文**（即 export 回调所处上下文）采集
 * JSON 规格，再进入 temp editor 重建——若在 temp editor 的 update 内对本
 * 编辑器之外的节点调用 exportJSON/getChildren，其内部 getLatest() 会按 key
 * 在当前活跃编辑器（temp）的 node map 中解析：key 冲突时静默取到错误节点，
 * 不冲突时 invariant 报错导致 temp update 回滚、读到陈旧状态。
 */
function alignedBlockToMarkdown(node: LexicalNode): string {
	const spec = specTreeFromNode(node);
	const editor = getNestedTempEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			root.append(nodeFromSpecTree(spec));
		},
		{ discrete: true }
	);
	return editor.getEditorState().read(() => $convertToMarkdownString(NESTED_EDITOR_TRANSFORMERS));
}

/**
 * 对齐容器 Transformer。
 *
 * markdown 无原生对齐语法，采用容器指令持久化块级对齐（与渲染端
 * remark-directive 插件约定）：
 *
 * :::center
 * 内容（任意顶层块语法）
 * :::
 *
 * - 导入：解析内部 markdown 为块序列并应用 text-align 格式。
 * - 导出：顶层块带 left/center/right/justify 格式时包回指令。
 *
 * 已知限制：指令内部不支持再嵌套 :::（alert/align），表格行会降级为文本。
 */
export const alignTransformer: MultilineElementTransformer = {
	dependencies: [],
	regExpStart: ALIGN_START_REGEX,
	regExpEnd: ALIGN_END_REGEX,
	replace: (rootNode, children, startMatch, _endMatch, linesInBetween, isImport) => {
		if (!isImport || children) return false;
		const align = startMatch[1];
		const inner = (linesInBetween ?? []).join('\n').trim();
		if (!inner) return false;
		for (const spec of markdownToAlignedBlockSpecs(inner, align)) {
			rootNode.append(nodeFromSpecTree(spec));
		}
	},
	export: (node) => {
		if (!$isElementNode(node)) return null;
		const format = node.getFormatType();
		if (!format || !ALIGN_FORMATS.includes(format)) return null;
		return `:::${format}\n${alignedBlockToMarkdown(node)}\n:::`;
	},
	type: 'multiline-element'
};

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
 * + Align + Sup/Sub。
 *
 * 顺序约定：自定义 transformer 在前（multiline 导入逐 transformer 尝试，
 * text-match 导出逐 transformer 尝试，靠前者优先），核心 TRANSFORMERS 在后。
 */
export const EDITOR_TRANSFORMERS: Transformer[] = [
	tagTransformer,
	alertTransformer,
	hrTransformer,
	imageTransformer,
	tableTransformer,
	alignTransformer,
	superscriptTransformer,
	subscriptTransformer,
	...TRANSFORMERS
];

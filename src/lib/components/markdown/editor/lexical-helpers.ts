import {
	type LexicalEditor,
	type LexicalNode,
	type TextFormatType,
	FORMAT_TEXT_COMMAND,
	$getSelection,
	$isRangeSelection,
	$createParagraphNode,
	$createTextNode
} from 'lexical';
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from '@lexical/rich-text';
import {
	$isListNode,
	type ListNode,
	INSERT_UNORDERED_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_CHECK_LIST_COMMAND,
	REMOVE_LIST_COMMAND
} from '@lexical/list';
import { INSERT_TABLE_COMMAND, $isTableNode } from '@lexical/table';
import { $createLinkNode } from '@lexical/link';
import { $createCodeNode } from '@lexical/code';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/extension';
import { $setBlocksType } from '@lexical/selection';
import { $insertNodeToNearestRoot } from '@lexical/utils';
import { $createTagNode, $isTagNode } from '$lib/components/markdown/tag/tag-node';
import { $createAlertNode, $isAlertNode } from '$lib/components/markdown/alert/alert-node';
import { $createImageNode } from '$lib/components/markdown/image/image-node';
import {
	DEFAULT_ALERT_TYPE,
	createDefaultAlertContent
} from '$lib/components/markdown/alert/alert-types';
import type { AlertType } from '$lib/components/markdown/alert/alert-types';

// ── 选区块定位（工具栏状态与 toggle 的统一依据）──

/**
 * 获取选区所在的顶层块节点（root 的直接子级）。
 * 光标在段落/标题/引用内返回该块；在列表内返回外层 ListNode；在表格内返回 TableNode。
 */
function $getTopLevelBlockFromSelection(): LexicalNode | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	// The official node method does the same walk (LexicalNode#getTopLevelElement)
	const anchor = selection.anchor.getNode();
	return anchor.getTopLevelElement() ?? anchor;
}

/**
 * 获取选区所在的最近 ListNode 祖先（不在列表中时返回 null）。
 * 嵌套列表时返回光标直接所在的那层列表。
 */
function $getNearestListNodeFromSelection(): ListNode | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	let node: LexicalNode | null = selection.anchor.getNode();
	while (node !== null) {
		if ($isListNode(node)) return node;
		node = node.getParent();
	}
	return null;
}

/** 切换标题级别：已是该级别则降为段落 */
export function toggleHeading(editor: LexicalEditor, level: HeadingTagType) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const block = $getTopLevelBlockFromSelection();
		if (!block) return;
		const isTargetHeading =
			block.getType() === 'heading' && (block as { getTag?: () => string }).getTag?.() === level;

		if (isTargetHeading) {
			$setBlocksType(selection, () => $createParagraphNode());
		} else {
			$setBlocksType(selection, () => $createHeadingNode(level));
		}
	});
}

/** 切换引用块 */
export function toggleBlockquote(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const block = $getTopLevelBlockFromSelection();
		if (!block) return;

		if (block.getType() === 'quote') {
			$setBlocksType(selection, () => $createParagraphNode());
		} else {
			$setBlocksType(selection, () => $createQuoteNode());
		}
	});
}

/** 切换无序列表（按选区所在列表判断开关，而非全文首个块） */
export function toggleBulletList(editor: LexicalEditor) {
	editor.update(() => {
		const list = $getNearestListNodeFromSelection();
		if (list && list.getListType() === 'bullet') {
			editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
		} else {
			editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
		}
	});
}

/** 切换有序列表（按选区所在列表判断开关） */
export function toggleOrderedList(editor: LexicalEditor) {
	editor.update(() => {
		const list = $getNearestListNodeFromSelection();
		if (list && list.getListType() === 'number') {
			editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
		} else {
			editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
		}
	});
}

/** 插入水平分割线 */
export function insertHorizontalRule(editor: LexicalEditor) {
	editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
}

// ── 插入辅助：链接 / 图片 / 表格 / 待办（markdown 语法 + Lexical 节点混合）──

/**
 * 插入链接。选中文本包裹为 LinkNode（WYSIWYG），
 * 未选中时以 URL 为文本创建链接。
 */
export function insertLink(editor: LexicalEditor, url: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const text = selection.isCollapsed() ? url : selection.getTextContent();
		const linkNode = $createLinkNode(url);
		linkNode.append($createTextNode(text));
		selection.insertNodes([linkNode]);
	});
}

/**
 * 插入图片（ImageNode，WYSIWYG）。
 * 编辑器内直接渲染 <img>，保存时由 imageTransformer 导出 ![alt](src)。
 */
export function insertImage(editor: LexicalEditor, url: string, alt: string = '') {
	editor.update(() => {
		// Same root-level contract as the other block inserts; the utility
		// appends the caret-carrying paragraph itself.
		$insertNodeToNearestRoot($createImageNode(url, alt));
	});
}

/**
 * 插入 3×3 表格（TableNode，WYSIWYG）。
 * 由 registerTablePlugin 处理 INSERT_TABLE_COMMAND 创建节点；
 * Markdown 往返由 tableTransformer 负责。
 */
export function insertTable(
	editor: LexicalEditor,
	rows = 3,
	columns = 3,
	includeHeaders: { rows: boolean; columns: boolean } = { rows: true, columns: false }
) {
	// 0.46 的 payload 中 rows/columns 为字符串类型
	editor.dispatchCommand(INSERT_TABLE_COMMAND, {
		rows: String(rows),
		columns: String(columns),
		includeHeaders
	});
}

/**
 * 插入代码块（CodeNode，WYSIWYG）。
 * 使用 Lexical 原生 CodeNode，编辑器内即可见代码块样式。
 */
export function insertCodeBlock(editor: LexicalEditor, language: string = '') {
	// focus() so typing lands in the editor right after the dialog closes;
	// the official utility resolves the insertion point itself (selection,
	// previous selection, or the root's end) — no range-selection guard, the
	// caret goes straight into the fresh fence (the table plugin's own
	// pattern: $insertNodeToNearestRoot + select the node).
	editor.focus(() => {
		editor.update(() => {
			$insertNodeToNearestRoot($createCodeNode(language)).selectStart();
		});
	});
}

/**
 * 插入/关闭待办列表项（toggle）。
 * 利用 Lexical ListNode + ListItemNode 的 checklist 变体；
 * 光标已在待办列表内时移除列表（转为普通段落）。
 */
export function insertCheckList(editor: LexicalEditor) {
	editor.update(() => {
		const list = $getNearestListNodeFromSelection();
		if (list && list.getListType() === 'check') {
			editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
		} else {
			editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
		}
	});
}

/**
 * 插入数学公式（`$$ ... $$` 源码文本，独占段落）。
 *
 * 编辑器内保持源码文本（与渲染管线的 remark-math/rehype-katex 约定一致）。
 * 公式作为独立段落插入当前块之后——micromark-extension-math 中 `$$...$$`
 * 只有独占一行才是块级公式，插在段落中间会被解析为行内公式。
 */
export function insertMath(editor: LexicalEditor, latex: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const paragraph = $createParagraphNode();
		paragraph.append($createTextNode(`$$ ${latex} $$`));
		const block = $getTopLevelBlockFromSelection();
		if (block) {
			block.insertAfter(paragraph);
		} else {
			selection.insertNodes([paragraph]);
		}
		paragraph.select();
	});
}

/**
 * 插入 Tag（内联彩色标签，TextNode 子类）。
 * 选中文本则转为 Tag，否则插入默认文本 "tag"。
 */
export function insertTag(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const text = selection.isCollapsed() ? 'tag' : selection.getTextContent();
		const tagNode = $createTagNode(text);
		selection.insertNodes([tagNode]);
	});
}

export { $createAlertNode, $isAlertNode };

import { $isTextNode } from 'lexical';
import { $createSpoilerNode, $isSpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { $isMentionNode } from '$lib/components/markdown/mention/mention-node';

/**
 * Toggle the spoiler node over the current selection (batch A).
 * - caret inside a spoiler: unwrap that node;
 * - a selection covering only spoilers: unwrap them all;
 * - a mixed selection: tokens (mention/tag) stay untouched and each text
 *   node converts individually;
 * - otherwise the selection text becomes one spoiler, keeping the first
 *   covered text node's format flags.
 */
export function toggleSpoiler(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const unwrap = (node: ReturnType<typeof $createSpoilerNode>) => {
			const plain = $createTextNode(node.getTextContent());
			plain.setFormat(node.getFormat());
			node.replace(plain);
		};
		if (selection.isCollapsed()) {
			const node = selection.anchor.getNode();
			if ($isSpoilerNode(node)) unwrap(node);
			return;
		}
		const covered = selection.getNodes();
		const isToken = (node: unknown) => $isMentionNode(node) || $isTagNode(node);
		const texts = covered.filter($isTextNode).filter((node) => !isToken(node));
		if (texts.length === 0) return;
		if (texts.every($isSpoilerNode)) {
			for (const node of texts) unwrap(node);
			return;
		}
		// splitText + replace: the same mechanism the markdown importer proves
		// out. insertNodes() would flatten a non-token TextNode subclass.
		const isStartPoint = (point: unknown) =>
			(selection.isBackward() ? selection.focus : selection.anchor) === point;
		for (const node of texts) {
			if ($isSpoilerNode(node)) continue;
			const size = node.getTextContentSize();
			const offsets = [selection.anchor, selection.focus]
				.filter((point) => point.type === 'text' && point.key === node.getKey())
				.map((point) => Math.min(Math.max(point.offset, 0), size));
			let start = 0;
			let end = size;
			if (offsets.length === 2) {
				start = Math.min(offsets[0], offsets[1]);
				end = Math.max(offsets[0], offsets[1]);
			} else if (offsets.length === 1) {
				if (
					isStartPoint(
						selection.anchor.type === 'text' && selection.anchor.key === node.getKey()
							? selection.anchor
							: selection.focus
					)
				) {
					start = offsets[0];
				} else {
					end = offsets[0];
				}
			}
			if (start >= end) continue;
			if (start === 0 && end === size) {
				const spoiler = $createSpoilerNode(node.getTextContent());
				spoiler.setFormat(node.getFormat());
				node.replace(spoiler);
			} else {
				const pieces = node.splitText(start, end);
				// Lexical's TextNode.splitText skips the zero-length leading segment
				// when start === 0, so the selected piece shifts one index left.
				const middle = start === 0 ? pieces[0] : pieces[1];
				const spoiler = $createSpoilerNode(middle.getTextContent());
				spoiler.setFormat(middle.getFormat());
				middle.replace(spoiler);
			}
		}
	});
	editor.focus();
}

/**
 * 插入 Alert/Callout 结构化块（DecoratorNode）。
 * 替代原来的 markdown 文本 Callout 插入方式。
 */
export function insertAlert(editor: LexicalEditor, type: AlertType = DEFAULT_ALERT_TYPE) {
	editor.update(() => {
		const alertNode = $createAlertNode(type, createDefaultAlertContent());
		// same root-level contract as the code block insert (no selection guard)
		$insertNodeToNearestRoot(alertNode);
	});
}

// Toolbar character formatting shared by the top and floating toolbars.

/** Initial toolbar state; keeps the shape in one place. */
export function emptyToolbarState(): ToolbarState {
	return {
		isBold: false,
		isItalic: false,
		isUnderline: false,
		isStrikethrough: false,
		isSuperscript: false,
		isSubscript: false,
		isCode: false,
		isHighlight: false,
		isSpoiler: false,
		blockType: 'paragraph',
		inTable: false
	};
}

/**
 * Apply a character format and return focus to the editor.
 * Clicking a toolbar button otherwise leaves the selection unusable
 * and the format is silently dropped.
 */
export function formatTextWithFocus(editor: LexicalEditor | null, format: TextFormatType): void {
	if (!editor) return;
	editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
	editor.focus();
}

// ── 工具栏状态读取（封装 $ 前缀函数，避免 .svelte 文件直接导入）──

/** 工具栏需要追踪的格式状态 */
export interface ToolbarState {
	isBold: boolean;
	isItalic: boolean;
	isUnderline: boolean;
	isStrikethrough: boolean;
	isSuperscript: boolean;
	isSubscript: boolean;
	isCode: boolean;
	isHighlight: boolean;
	isSpoiler: boolean;
	blockType: 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote';
	/** 光标是否在表格单元格内(块级插入应禁用) */
	inTable: boolean;
}

/**
 * 在 editorState.read() 上下文中读取当前选区的格式状态。
 *
 * 封装 Lexical 的 $ 前缀函数，使 .svelte 文件无需直接导入它们
 * （Svelte 5 编译器会误将 $ 前缀解析为 store 自动订阅）。
 */
export function readToolbarState(): ToolbarState {
	const selection = $getSelection();
	const state = emptyToolbarState();

	if ($isRangeSelection(selection)) {
		state.isBold = selection.hasFormat('bold');
		state.isItalic = selection.hasFormat('italic');
		state.isUnderline = selection.hasFormat('underline');
		state.isStrikethrough = selection.hasFormat('strikethrough');
		state.isSuperscript = selection.hasFormat('superscript');
		state.isSubscript = selection.hasFormat('subscript');
		state.isCode = selection.hasFormat('code');
		state.isHighlight = selection.hasFormat('highlight');
		state.isSpoiler =
			$isSpoilerNode(selection.anchor.getNode()) || $isSpoilerNode(selection.focus.getNode());

		// 从锚点向上找表格祖先(块级插入在表格内应禁用)
		let tableNode: LexicalNode | null = selection.anchor.getNode();
		while (tableNode) {
			if ($isTableNode(tableNode)) {
				state.inTable = true;
				break;
			}
			tableNode = tableNode.getParent();
		}
	}

	// 当前块：优先按选区所在列表（含嵌套），否则按选区顶层块判定
	const list = $getNearestListNodeFromSelection();
	if (list) {
		const listType = list.getListType();
		state.blockType = listType === 'number' ? 'number' : listType === 'check' ? 'check' : 'bullet';
	} else {
		const block = $getTopLevelBlockFromSelection();
		const type = block?.getType?.() ?? 'paragraph';
		if (type === 'heading') {
			const tag = (block as { getTag?: () => string }).getTag?.() ?? 'h1';
			state.blockType = tag as ToolbarState['blockType'];
		} else if (type === 'quote') {
			state.blockType = 'quote';
		}
	}

	return state;
}

/** 将当前块转换为段落（用于 BlockMenu 的"正文"选项） */
export function applyParagraph(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		$setBlocksType(selection, () => $createParagraphNode());
	});
}

/**
 * 获取当前文本选区的 DOM 矩形，用于浮动工具栏定位。
 * 返回 null 表示无有效选区。
 */
export function getSelectionRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	// 忽略编辑器外的选区
	const editorRoot = document.querySelector('[data-lexical-editor="true"]');
	if (editorRoot && !editorRoot.contains(range.commonAncestorContainer)) return null;
	return range.getBoundingClientRect();
}

// 来自 alert-node.ts 的 $ 前缀函数也需要别名
export { $isAlertNode as isAlertNode };

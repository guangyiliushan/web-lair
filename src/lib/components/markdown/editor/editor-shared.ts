import type { EditorThemeClasses } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { HorizontalRuleNode } from '@lexical/extension';
import { SpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { MentionNode } from '$lib/components/markdown/mention/mention-node';

/**
 * 嵌套编辑器节点子集与 Theme 配置。
 *
 * 独立成模块且不引用自定义 TagNode/AlertNode：依赖链
 * alert-node → alert-decorator → 本模块 必须在此终止，
 * 否则在 alert-node 先于 editor-nodes 初始化的导入顺序下，
 * 自定义节点类处于 TDZ，数组/依赖里会得到 undefined。
 */

/** 嵌套编辑器节点子集（不含 AlertNode 和 TagNode，防止无限嵌套） */
export const NESTED_EDITOR_NODES = [
	HeadingNode,
	ListNode,
	ListItemNode,
	QuoteNode,
	CodeNode,
	CodeHighlightNode,
	LinkNode,
	HorizontalRuleNode,
	SpoilerNode,
	MentionNode
];

/**
 * Lexical 编辑器 Theme 配置。
 *
 * 将各节点类型映射到语义化 CSS 类名，由组件层 CSS 提供实际样式。
 * 参考 Mx Space Admin 的 rich-heading-h1/h2/h3 命名惯例。
 *
 * 注意：类名通过 `:global()` 定义在 MarkdownEditor.svelte 的 scoped style 中，
 * 支持 Tailwind `@apply` 以确保与设计系统一致。
 */
export const EDITOR_THEME: EditorThemeClasses = {
	heading: {
		h1: 'rich-editor-h1',
		h2: 'rich-editor-h2',
		h3: 'rich-editor-h3',
		h4: 'rich-editor-h4',
		h5: 'rich-editor-h5',
		h6: 'rich-editor-h6'
	},
	list: {
		ul: 'rich-editor-ul',
		ol: 'rich-editor-ol',
		listitem: 'rich-editor-li',
		listitemChecked: 'rich-editor-listitem-checked',
		listitemUnchecked: 'rich-editor-listitem-unchecked',
		checklist: 'rich-editor-checklist',
		nested: {
			listitem: 'rich-editor-nested-li'
		}
	},
	quote: 'rich-editor-quote',
	code: 'rich-editor-code-block',
	// ── 表格（@lexical/table 0.46 主题键，tableCellSelected/tableSelection 由包自动增删）──
	table: 'rich-editor-table',
	tableRow: 'rich-editor-table-row',
	tableCell: 'rich-editor-table-cell',
	tableCellHeader: 'rich-editor-table-cell-header',
	tableCellSelected: 'rich-editor-table-cell-selected',
	tableSelection: 'rich-editor-table-selection',
	text: {
		bold: 'rich-editor-bold',
		italic: 'rich-editor-italic',
		underline: 'rich-editor-underline',
		strikethrough: 'rich-editor-strikethrough',
		code: 'rich-editor-inline-code',
		highlight: 'rich-editor-highlight'
	}
};

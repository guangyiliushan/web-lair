import type { EditorThemeClasses } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { HorizontalRuleNode } from '@lexical/extension';
import { SpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { MentionNode } from '$lib/components/markdown/mention/mention-node';
import { InlineMathNode } from '$lib/components/markdown/math/inline-math-node';
import { BlockMathNode } from '$lib/components/markdown/math/block-math-node';
import { FootnoteRefNode } from '$lib/components/markdown/footnote/footnote-ref-node';
import { FootnoteInlineNode } from '$lib/components/markdown/footnote/footnote-inline-node';
import { EmbedNode } from '$lib/components/markdown/embed/embed-node';
import { MermaidNode } from '$lib/components/markdown/editor/mermaid-block-node';
import { DetailsNode } from '$lib/components/markdown/details/details-node';
import { TabsNode } from '$lib/components/markdown/tabs/tabs-node';
import { GridNode } from '$lib/components/markdown/grid/grid-node';

// Nested editor node subset and Theme configuration.
//
// A standalone module that never imports the custom TagNode/AlertNode: the
// dependency chain alert-node → alert-decorator → this module must terminate here,
// otherwise, in an import order where alert-node initialises before editor-nodes,
// the custom node classes are still in the TDZ and the arrays/dependencies get
// undefined.

/** Nested editor node subset (AlertNode and TagNode excluded to prevent infinite nesting) */
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
	MentionNode,
	InlineMathNode,
	BlockMathNode,
	FootnoteRefNode,
	FootnoteInlineNode,
	EmbedNode,
	MermaidNode,
	DetailsNode,
	TabsNode,
	GridNode
];

/**
 * Lexical editor Theme configuration.
 *
 * Maps each node type to a semantic CSS class; the component layer's CSS provides the
 * actual styling. Follows the rich-heading-h1/h2/h3 naming convention of Mx Space Admin.
 *
 * Note: the class names are declared with `:global()` in MarkdownEditor.svelte's scoped
 * style and support Tailwind `@apply`, keeping them aligned with the design system.
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
	// ── Table (the @lexical/table 0.46 theme keys; tableCellSelected/tableSelection are
	// added and removed by the package itself) ──
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

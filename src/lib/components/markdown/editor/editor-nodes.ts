import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { HorizontalRuleNode } from '@lexical/extension';
import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
import { TagNode } from '$lib/components/markdown/tag/tag-node';
import { SpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { MentionNode } from '$lib/components/markdown/mention/mention-node';
import { AlertNode } from '$lib/components/markdown/alert/alert-node';
import { ImageNode } from '$lib/components/markdown/image/image-node';
import { InlineMathNode } from '$lib/components/markdown/math/inline-math-node';
import { BlockMathNode } from '$lib/components/markdown/math/block-math-node';
import { FootnoteRefNode } from '$lib/components/markdown/footnote/footnote-ref-node';
import { FootnoteInlineNode } from '$lib/components/markdown/footnote/footnote-inline-node';
import { EmbedNode } from '$lib/components/markdown/embed/embed-node';
import { MermaidNode } from '$lib/components/markdown/editor/mermaid-block-node';
import { DetailsNode } from '$lib/components/markdown/details/details-node';
import { TabsNode } from '$lib/components/markdown/tabs/tabs-node';
import { GridNode } from '$lib/components/markdown/grid/grid-node';

/** Editor node registry (custom nodes: see the split rationale in editor-shared.ts) */
export const EDITOR_NODES = [
	HeadingNode,
	ListNode,
	ListItemNode,
	QuoteNode,
	CodeNode,
	CodeHighlightNode,
	LinkNode,
	HorizontalRuleNode,
	TableNode,
	TableRowNode,
	TableCellNode,
	TagNode,
	AlertNode,
	ImageNode,
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

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

/** 编辑器节点注册列表（自定义节点见 editor-shared.ts 的拆分说明） */
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
	MentionNode
];

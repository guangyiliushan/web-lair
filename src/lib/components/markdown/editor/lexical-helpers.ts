import {
	type LexicalEditor,
	type LexicalNode,
	type TextFormatType,
	type TextNode,
	FORMAT_TEXT_COMMAND,
	$getRoot,
	$isTextNode,
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
import { $createFootnoteRefNode } from '$lib/components/markdown/footnote/footnote-ref-node';
import { $createFootnoteInlineNode } from '$lib/components/markdown/footnote/footnote-inline-node';
import { $createMentionNode } from '$lib/components/markdown/mention/mention-node';
import { $createDetailsNode } from '$lib/components/markdown/details/details-node';
import { $createEmbedNode } from '$lib/components/markdown/embed/embed-node';
import { resolveProviderId } from '$lib/components/markdown/embed/registry';
import { $createMermaidNode } from '$lib/components/markdown/editor/mermaid-block-node';
import { $createTabsNode, type SerializedTabEntry } from '$lib/components/markdown/tabs/tabs-node';
import { $createGridNode } from '$lib/components/markdown/grid/grid-node';
// ── Selection-block resolution (single basis for toolbar state and toggles) ──

/**
 * Get the top-level block node containing the selection (a direct child of root).
 * Inside a paragraph/heading/quote it returns that block; inside a list the outer
 * ListNode; inside a table the TableNode.
 */
function $getTopLevelBlockFromSelection(): LexicalNode | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	// The official node method does the same walk (LexicalNode#getTopLevelElement)
	const anchor = selection.anchor.getNode();
	return anchor.getTopLevelElement() ?? anchor;
}

/**
 * Get the nearest ListNode ancestor of the selection (null when not in a list).
 * For nested lists it returns the level the cursor sits directly in.
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

/** Toggle a heading level: back to a paragraph when already at that level */
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

/** Toggle the blockquote */
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

/** Toggle the bullet list (state read from the list containing the selection,
 * not from the document's first block) */
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

/** Toggle the ordered list (state read from the list containing the selection) */
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

/** Insert a horizontal rule */
export function insertHorizontalRule(editor: LexicalEditor) {
	editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
}

// ── Insert helpers: link / image / table / checklist (markdown syntax plus Lexical nodes) ──

/**
 * Insert a link. A text selection is wrapped into a LinkNode (WYSIWYG); with no
 * selection the URL itself becomes the link text.
 */
/**
 * Link shapes accepted by the editor's insert/display paths, aligned with
 * the render side: absolute http(s)/mailto/tel, site-rooted relative paths
 * (single slash: `/posts/...`) and `#` anchors all survive sanitize, so the
 * editor accepts them too. Two deliberate carve-outs stay out of the
 * insert path: protocol-relative `//host` and everything with a script or
 * data scheme (the render side strips those regardless).
 */
const SAFE_LINK_SCHEME = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;
export function isSafeLinkUrl(url: string): boolean {
	return SAFE_LINK_SCHEME.test(url.trim());
}

export function insertLink(editor: LexicalEditor, url: string) {
	if (!isSafeLinkUrl(url)) return;
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
 * Insert an image (ImageNode, WYSIWYG).
 * The editor renders <img> directly; imageTransformer exports ![alt](src) on save.
 */
export function insertImage(
	editor: LexicalEditor,
	url: string,
	alt: string = '',
	tailAttrs: string = ''
) {
	editor.update(() => {
		// Same root-level contract as the other block inserts; the utility
		// appends the caret-carrying paragraph itself. `tailAttrs` is the
		// raw inner text of `{...}` (spec 2 #7, e.g. `width=480 height=320`).
		$insertNodeToNearestRoot($createImageNode(url, alt, tailAttrs));
	});
}

/**
 * Insert a 3×3 table (TableNode, WYSIWYG).
 * registerTablePlugin handles INSERT_TABLE_COMMAND and creates the nodes;
 * tableTransformer owns the Markdown round-trip.
 */
export function insertTable(
	editor: LexicalEditor,
	rows = 3,
	columns = 3,
	includeHeaders: { rows: boolean; columns: boolean } = { rows: true, columns: false }
) {
	// In 0.46's payload rows/columns are strings
	editor.dispatchCommand(INSERT_TABLE_COMMAND, {
		rows: String(rows),
		columns: String(columns),
		includeHeaders
	});
}

/**
 * Insert a code block (CodeNode, WYSIWYG).
 * Uses Lexical's native CodeNode, so code-block styling shows in the editor.
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
 * Insert/toggle a checklist item.
 * Uses the checklist variant of Lexical's ListNode + ListItemNode; when the cursor
 * is already in a checklist the list is removed (back to a plain paragraph).
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
 * Insert a math formula (`$$ ... $$` source text, alone in its paragraph).
 *
 * The editor keeps the source text (matching the render pipeline's remark-math /
 * rehype-katex contract). The formula is inserted as its own paragraph after the
 * current block — in micromark-extension-math `$$...$$` is block-level only when
 * alone on a line; inserting it mid-paragraph parses as inline math.
 */
export function insertMath(editor: LexicalEditor, latex: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const node = $createBlockMathNode(latex);
		const block = $getTopLevelBlockFromSelection();
		if (block) {
			block.insertAfter(node);
		} else {
			$getRoot().append(node);
		}
		// decorator nodes have no select(): leave a paragraph for the caret
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

/**
 * Insert a Tag (inline coloured label, a TextNode subclass).
 * A text selection becomes the Tag; otherwise the default text "tag" is inserted.
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

import { $getNodeByKey } from 'lexical';
import { $createSpoilerNode, $isSpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { $isMentionNode } from '$lib/components/markdown/mention/mention-node';
import {
	$createBlockMathNode,
	$isBlockMathNode
} from '$lib/components/markdown/math/block-math-node';
import { $isInlineMathNode } from '$lib/components/markdown/math/inline-math-node';

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
 * Insert a structured Alert/Callout block (DecoratorNode).
 * Replaces the old markdown-text Callout insertion path.
 */
export function insertAlert(editor: LexicalEditor, type: AlertType = DEFAULT_ALERT_TYPE) {
	editor.update(() => {
		const alertNode = $createAlertNode(type, createDefaultAlertContent());
		// same root-level contract as the code block insert (no selection guard)
		$insertNodeToNearestRoot(alertNode);
	});
}

/** Reads an inline/block math node for the click-to-edit dialog (batch B). */
export function getMathNodeInfo(
	editor: LexicalEditor,
	key: string
): { latex: string; displayMode: boolean } | null {
	return editor.getEditorState().read(() => {
		const node = $getNodeByKey(key);
		if ($isInlineMathNode(node)) return { latex: node.getLatex(), displayMode: false };
		if ($isBlockMathNode(node)) return { latex: node.getLatex(), displayMode: true };
		return null;
	});
}

/** Applies the dialog's LaTeX back onto the math node (batch B). */
export function updateMathNode(editor: LexicalEditor, key: string, latex: string): void {
	editor.update(() => {
		const node = $getNodeByKey(key);
		if ($isInlineMathNode(node) || $isBlockMathNode(node)) node.setLatex(latex);
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

// ── Toolbar state readers (wrap the $-prefixed helpers so .svelte never imports them) ──

/** Format state the toolbar tracks */
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
	/** Whether the cursor sits inside a table cell (block-level inserts must be disabled) */
	inTable: boolean;
}

/**
 * Read the format state of the current selection inside editorState.read().
 *
 * Wraps Lexical's $-prefixed functions so .svelte files need not import them
 * (the Svelte 5 compiler would read a leading $ as a store auto-subscription).
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

		// Walk up from the anchor to the table ancestor (block inserts must be disabled in a table)
		let tableNode: LexicalNode | null = selection.anchor.getNode();
		while (tableNode) {
			if ($isTableNode(tableNode)) {
				state.inTable = true;
				break;
			}
			tableNode = tableNode.getParent();
		}
	}

	// Current block: prefer the list containing the selection (nested included), otherwise
	// fall back to the selection's top-level block
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

/** Convert the current block into a paragraph (BlockMenu's "body text" option) */
export function applyParagraph(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		$setBlocksType(selection, () => $createParagraphNode());
	});
}

/**
 * Get the DOM rect of the current text selection, used to position the floating toolbar.
 * Returns null when there is no usable selection.
 */
export function getSelectionRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	// Ignore selections outside the editor
	const editorRoot = document.querySelector('[data-lexical-editor="true"]');
	if (editorRoot && !editorRoot.contains(range.commonAncestorContainer)) return null;
	return range.getBoundingClientRect();
}

// $-prefixed helpers from alert-node.ts need aliases here as well
export { $isAlertNode as isAlertNode };

// ── Insert surface (footnote / mention / details / embed card / containers) ─────
//
// These nodes, their `$create*` factories and round-trip transformers already
// existed; only the toolbar entry points were missing (UX-1020 "restore the
// removed insert capabilities"). Every factory builds nodes from the exported
// source literals, so insert → export markdown → import is an identity.

/** Walks every text node under the root (for the next free footnote label). */
function collectTextNodes(): TextNode[] {
	const out: TextNode[] = [];
	const stack: LexicalNode[] = [$getRoot()];
	while (stack.length > 0) {
		const node = stack.pop() as LexicalNode;
		if ($isTextNode(node)) out.push(node);
		// ElementNode#getChildren covers every container type in EDITOR_NODES
		const children =
			'getChildren' in node ? (node as { getChildren(): LexicalNode[] }).getChildren() : [];
		for (const child of children) stack.push(child);
	}
	return out;
}

/**
 * Next free footnote label: `[^1]` chips already in the document are counted
 * so a second insert does not collide with the first.
 */
function nextFootnoteLabel(): string {
	let max = 0;
	for (const node of collectTextNodes()) {
		const match = /^\[\^(\d+)\]$/.exec(node.getTextContent());
		if (match) max = Math.max(max, Number(match[1]));
	}
	return String(max + 1);
}

/** Footnote reference `[^N]`: atomic chip, labels auto-increment, nothing to type. */
export function insertFootnoteRef(editor: LexicalEditor, label?: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const id = label?.trim() || nextFootnoteLabel();
		selection.insertNodes([$createFootnoteRefNode(`[^${id}]`)]);
	});
}

/** Inline footnote `^[body]` (pandoc style); the body is supplied by the caller. */
export function insertFootnoteInline(editor: LexicalEditor, text: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const body = text.trim() || '…';
		selection.insertNodes([$createFootnoteInlineNode(`^[${body}]`)]);
	});
}

/**
 * Mention `@gh:user` / `@tw:user` / `@tg:user`. The token is atomic and the cursor
 * cannot enter it, so the handle must be settled before insertion (the toolbar
 * uses an input field, never `window.prompt`).
 */
export function insertMention(editor: LexicalEditor, handle: string) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const token = handle.trim();
		if (!token) return;
		selection.insertNodes([$createMentionNode(token.startsWith('@') ? token : `@${token}`)]);
	});
}

/** Details block `:::details{…}` / `:::spoiler{…}`; defaults to open with an empty body. */
export function insertDetails(editor: LexicalEditor, variant: 'details' | 'spoiler' = 'details') {
	editor.update(() => {
		const node = $createDetailsNode(variant, '', '', false, true, createDefaultAlertContent());
		$insertNodeToNearestRoot(node);
		// decorator nodes have no select(): leave a paragraph for the caret
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

/** Embed card: the provider is resolved from the URL, falling back to generic. */
export function insertEmbed(editor: LexicalEditor, url: string, title = '') {
	editor.update(() => {
		const trimmed = url.trim();
		if (!trimmed) return;
		const node = $createEmbedNode(trimmed, title.trim() || trimmed, resolveProviderId(trimmed));
		$insertNodeToNearestRoot(node);
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

/**
 * Starter diagram for a new Mermaid block. English labels on purpose: the
 * admin i18n guard (A2) rejects hardcoded CJK outside comments, and this is
 * only a placeholder the author replaces anyway.
 */
export const DEFAULT_MERMAID_SOURCE = 'graph TD\n  A[Start] --> B[End]';

/** Mermaid diagram (```mermaid fence). */
export function insertMermaid(editor: LexicalEditor, source: string = DEFAULT_MERMAID_SOURCE) {
	editor.update(() => {
		const node = $createMermaidNode(source);
		$insertNodeToNearestRoot(node);
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

/** Tabs container `:::tabs`, two panes by default. */
export function insertTabs(editor: LexicalEditor, labels: string[] = ['Tab 1', 'Tab 2']) {
	editor.update(() => {
		const tabs: SerializedTabEntry[] = labels.map((label) => ({
			label,
			labelExplicit: true,
			jsonContent: createDefaultAlertContent()
		}));
		const node = $createTabsNode(
			tabs.length > 0
				? tabs
				: [{ label: 'Tab 1', labelExplicit: true, jsonContent: createDefaultAlertContent() }]
		);
		$insertNodeToNearestRoot(node);
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

/** Column container (grid / masonry / carousel). */
export function insertGrid(
	editor: LexicalEditor,
	layout: 'grid' | 'masonry' | 'carousel' = 'grid',
	cols = 2
) {
	editor.update(() => {
		const node = $createGridNode(
			'',
			cols,
			null,
			8,
			layout,
			'normal',
			[],
			createDefaultAlertContent()
		);
		$insertNodeToNearestRoot(node);
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.select();
	});
}

import {
	type LexicalEditor,
	type AnyLexicalCommand,
	type ElementNode,
	type LexicalNode,
	$getRoot,
	$getNodeByKey,
	$createParagraphNode,
	$isElementNode,
	$getSelection,
	$isRangeSelection
} from 'lexical';
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { $createCodeNode } from '@lexical/code';
import {
	INSERT_UNORDERED_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_CHECK_LIST_COMMAND
} from '@lexical/list';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/extension';
import { $setBlocksType } from '@lexical/selection';

type BlockCommandMap = Record<string, AnyLexicalCommand>;
type BlockCreatorMap = Record<string, () => ElementNode>;

// ── Block Handle helpers ──

/**
 * Insert an empty paragraph after the block with the given key and focus it.
 */
export function insertBlockAfter(editor: LexicalEditor, blockKey: string) {
	editor.update(() => {
		const node = $getNodeByKey(blockKey);
		if (!node) return;
		const paragraph = $createParagraphNode();
		node.insertAfter(paragraph);
		paragraph.selectStart();
	});
}

/**
 * Duplicate the block with the given key and insert the copy after it.
 * selectedKeys duplicates several blocks at once (when empty, only blockKey is copied).
 */
export function duplicateBlocks(
	editor: LexicalEditor,
	blockKey: string,
	selectedKeys: string[] = []
) {
	const keys = selectedKeys.length > 0 ? selectedKeys : [blockKey];
	if (!keys.length) return;

	editor.update(() => {
		const root = $getRoot();
		const children = root.getChildren();
		const keySet = new Set(keys);
		const nodesToDuplicate = children.filter((child) => keySet.has(child.getKey()));
		if (!nodesToDuplicate.length) return;

		let insertAfter = nodesToDuplicate.at(-1)!;
		for (const node of nodesToDuplicate) {
			// Deep clone through JSON serialization
			const Klass = node.constructor as typeof LexicalNode;
			const serialized = node.exportJSON();
			const clone = Klass.importJSON(serialized);
			if ($isElementNode(node) && $isElementNode(clone)) {
				for (const child of node.getChildren()) {
					clone.append(cloneChild(child));
				}
			}
			insertAfter.insertAfter(clone);
			insertAfter = clone;
		}
	});
}

/** Recursively clone child nodes */
function cloneChild(node: LexicalNode): LexicalNode {
	const Klass = node.constructor as typeof LexicalNode;
	const serialized = node.exportJSON();
	const clone = Klass.importJSON(serialized);
	if ($isElementNode(node) && $isElementNode(clone)) {
		for (const child of node.getChildren()) {
			clone.append(cloneChild(child));
		}
	}
	return clone;
}

/**
 * Move the block up: swap it with its previous sibling.
 */
export function moveBlockUp(editor: LexicalEditor, blockKey: string, selectedKeys: string[] = []) {
	const keys = selectedKeys.length > 0 ? selectedKeys : [blockKey];
	if (!keys.length) return;

	editor.update(() => {
		const root = $getRoot();
		const children = root.getChildren();
		const keySet = new Set(keys);
		const selectedNodes = children.filter((child) => keySet.has(child.getKey()));
		if (!selectedNodes.length) return;

		const firstSelected = selectedNodes[0];
		const previousSibling = firstSelected.getPreviousSibling();
		if (!previousSibling || keySet.has(previousSibling.getKey())) return;

		const lastSelected = selectedNodes.at(-1)!;
		previousSibling.remove();
		lastSelected.insertAfter(previousSibling);
	});
}

/**
 * Move the block down: swap it with its next sibling.
 */
export function moveBlockDown(
	editor: LexicalEditor,
	blockKey: string,
	selectedKeys: string[] = []
) {
	const keys = selectedKeys.length > 0 ? selectedKeys : [blockKey];
	if (!keys.length) return;

	editor.update(() => {
		const root = $getRoot();
		const children = root.getChildren();
		const keySet = new Set(keys);
		const selectedNodes = children.filter((child) => keySet.has(child.getKey()));
		if (!selectedNodes.length) return;

		const lastSelected = selectedNodes.at(-1)!;
		const nextSibling = lastSelected.getNextSibling();
		if (!nextSibling || keySet.has(nextSibling.getKey())) return;

		const firstSelected = selectedNodes[0];
		nextSibling.remove();
		firstSelected.insertBefore(nextSibling);
	});
}

/**
 * Delete the block with the given key together with the selected siblings and restore
 * the selection to a sensible position.
 */
export function deleteBlocks(editor: LexicalEditor, blockKey: string, selectedKeys: string[] = []) {
	const keys = selectedKeys.length > 0 ? selectedKeys : [blockKey];
	if (!keys.length) return;

	editor.update(() => {
		const root = $getRoot();
		const children = root.getChildren();
		const keySet = new Set(keys);
		const nodesToDelete = children.filter((child) => keySet.has(child.getKey()));
		if (!nodesToDelete.length) return;

		const firstNode = nodesToDelete[0];
		const lastNode = nodesToDelete.at(-1)!;
		const previousSibling = firstNode.getPreviousSibling();
		const nextSibling = lastNode.getNextSibling();

		for (const node of nodesToDelete) {
			node.remove();
		}

		// Keep at least one paragraph in the root
		if (root.getChildrenSize() === 0) {
			const paragraph = $createParagraphNode();
			root.append(paragraph);
			paragraph.selectStart();
			return;
		}

		if (nextSibling && $isElementNode(nextSibling)) {
			nextSibling.selectStart();
		} else if (previousSibling && $isElementNode(previousSibling)) {
			previousSibling.selectEnd();
		}
	});
}

/**
 * Convert the given block into another type (paragraph / h1 / h2 / h3 / bullet /
 * numbered / todo / quote / code / divider).
 */
export function turnBlockInto(editor: LexicalEditor, blockKey: string, type: string) {
	if (['bullet', 'numbered', 'todo', 'divider'].includes(type)) {
		// Focus the node first
		editor.update(() => {
			const node = $getNodeByKey(blockKey);
			if (node && $isElementNode(node)) node.selectStart();
		});

		// Then convert through the command
		const commands: BlockCommandMap = {
			bullet: INSERT_UNORDERED_LIST_COMMAND,
			numbered: INSERT_ORDERED_LIST_COMMAND,
			todo: INSERT_CHECK_LIST_COMMAND,
			divider: INSERT_HORIZONTAL_RULE_COMMAND
		};
		const cmd = commands[type];
		if (cmd) editor.dispatchCommand(cmd, undefined);
		return;
	}

	editor.update(() => {
		const node = $getNodeByKey(blockKey);
		if (!node || !$isElementNode(node)) return;
		node.selectStart();
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;

		const creators: BlockCreatorMap = {
			paragraph: () => $createParagraphNode(),
			h1: () => $createHeadingNode('h1'),
			h2: () => $createHeadingNode('h2'),
			h3: () => $createHeadingNode('h3'),
			quote: () => $createQuoteNode(),
			code: () => $createCodeNode('')
		};
		const create = creators[type];
		if (create) $setBlocksType(selection, create);
	});
}

/** Resolve a DOM element to its top-level block (a child whose parentElement === rootElement) */
export function getBlockElement(editor: LexicalEditor, target: HTMLElement): HTMLElement | null {
	const rootElement = editor.getRootElement();
	if (!rootElement) return null;
	let current: HTMLElement | null = target;
	while (current && current !== rootElement) {
		if (current.parentElement === rootElement) return current;
		current = current.parentElement;
	}
	return null;
}

/** Find the nearest top-level block element by clientY */
export function getNearestBlockByY(rootElement: HTMLElement, clientY: number): HTMLElement | null {
	const blocks = [...rootElement.children].filter(
		(child): child is HTMLElement => child instanceof HTMLElement
	);
	if (!blocks.length) return null;

	let nearestBlock: HTMLElement | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const block of blocks) {
		const rect = block.getBoundingClientRect();
		if (rect.height <= 0) continue;
		if (clientY >= rect.top && clientY <= rect.bottom) return block;

		const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestBlock = block;
		}
	}

	return nearestBlock;
}

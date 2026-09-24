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

// ── Block Handle 辅助函数 ──

/**
 * 在指定 key 的块节点之后插入一个空段落并聚焦。
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
 * 复制指定 key 的块节点，插入到其后。
 * 支持通过 selectedKeys 批量复制（selectedKeys 为空时仅复制 blockKey）。
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
			// 通过 JSON 序列化实现深层克隆
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

/** 递归克隆子节点 */
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
 * 上移块：将其与前一个兄弟节点交换位置。
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
 * 下移块：将其与后一个兄弟节点交换位置。
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
 * 删除指定 key 的块及其选中的兄弟块，并恢复选区到合理位置。
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

		// 确保根节点至少有一个段落
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
 * 将指定块转换为其他类型（paragraph / h1 / h2 / h3 / bullet / numbered / todo / quote / code / divider）。
 */
export function turnBlockInto(editor: LexicalEditor, blockKey: string, type: string) {
	if (['bullet', 'numbered', 'todo', 'divider'].includes(type)) {
		// 先聚焦到该节点
		editor.update(() => {
			const node = $getNodeByKey(blockKey);
			if (node && $isElementNode(node)) node.selectStart();
		});

		// 然后用 command 转换
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

/** 通过 DOM 元素找到其对应的顶级块（parentElement === rootElement 的子元素） */
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

/** 根据 clientY 找到最近的顶级块元素 */
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

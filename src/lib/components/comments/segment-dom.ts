/**
 * DOM half of the segment anchor (comment P3b, spec §3/§5).
 *
 * The server derives its block directory from the rendered hast tree; the
 * reader selects text in the DOM. Both sides must agree on what a block is and
 * what its normalized text is, so this walker feeds its nodes through the same
 * `foldSegments` / `isAnchorSkipped` / `isAnchorBlock` rules — the only
 * difference is the node handle (`{node, parent}` here, `{node, parent}` when
 * the server maps hast text nodes).
 *
 * Selection mapping uses Range.comparePoint against a collapsed probe range at
 * each endpoint, which keeps element-container endpoints (triple click, whole
 * paragraph) working without a second, subtly different offset model.
 */
import {
	ANCHOR_MAX_LENGTH,
	ANCHOR_MIN_LENGTH,
	ANCHOR_SKIP_WRAPPERS,
	codePointSlice,
	foldSegments,
	isAnchorBlock,
	isAnchorSkipped,
	type FoldSegment
} from '$lib/utils/comment-anchor';

export interface DomTextPoint {
	node: Text;
	parent: Element;
	/** UTF-16 offset of this code point inside `node.data`. */
	offset: number;
	/** UTF-16 length of this code point (1, or 2 for a surrogate pair). */
	length: number;
}

export interface DomBlock {
	ord: number;
	/** Normalized block text (spec §3). */
	text: string;
	points: DomTextPoint[];
	element: HTMLElement;
}

export interface SegmentSelection {
	ord: number;
	start: number;
	end: number;
	/** The selected text after normalization (code points [start, end)). */
	exact: string;
	/** Viewport rect of the selection, for the floating action. */
	rect: DOMRect;
}

function shapeOf(element: Element) {
	return {
		tag: element.tagName.toLowerCase(),
		className: Array.from(element.classList),
		hasAttr: (name: string) => element.hasAttribute(name)
	};
}

function isWrapperElement(element: Element): boolean {
	const tag = element.tagName.toLowerCase();
	return ANCHOR_SKIP_WRAPPERS.some(
		(wrapper) => wrapper.tag === tag && element.querySelector(wrapper.contains) !== null
	);
}

/** True when `node` sits inside a subtree the block text deliberately skips. */
function insideSkipped(node: Node, block: Element): boolean {
	let current: Element | null =
		node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	while (current && current !== block) {
		if (isAnchorSkipped(shapeOf(current)) || isWrapperElement(current)) return true;
		current = current.parentElement;
	}
	return false;
}

/** Anchorable blocks of one rendered article, in document order. */
export function collectDomBlocks(root: HTMLElement): DomBlock[] {
	const blocks: DomBlock[] = [];
	type DomSegment = FoldSegment<{ node: Text; parent: Element }>;
	let current: DomSegment[] | null = null;
	let currentElement: HTMLElement | null = null;
	const stack: { segments: DomSegment[] | null; element: HTMLElement | null }[] = [];

	const walk = (element: Element) => {
		if (isAnchorSkipped(shapeOf(element)) || isWrapperElement(element)) return;
		const isBlock = isAnchorBlock(shapeOf(element));
		if (isBlock) {
			stack.push({ segments: current, element: currentElement });
			current = [];
			currentElement = element as HTMLElement;
		}
		for (const child of element.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				if (current) {
					current.push({
						value: (child as Text).data,
						ref: { node: child as Text, parent: element }
					});
				}
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				walk(child as Element);
			}
		}
		if (isBlock) {
			const finished = current ?? [];
			const element = currentElement;
			const restored = stack.pop();
			current = restored?.segments ?? null;
			currentElement = restored?.element ?? null;
			if (!element) return;
			const folded = foldSegments(finished);
			if (folded.text.length === 0) return;
			blocks.push({
				ord: -1,
				text: folded.text,
				element,
				points: folded.points.map((point) => ({
					node: point.ref.node,
					parent: point.ref.parent,
					offset: point.offset,
					length: point.length
				}))
			});
		}
	};

	for (const child of root.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE) walk(child as Element);
	}

	// Nested blocks close before their parent; sort by document order instead of
	// carrying the server's insert-index bookkeeping.
	blocks.sort((a, b) => {
		const relation = a.element.compareDocumentPosition(b.element);
		if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	});
	blocks.forEach((block, index) => {
		block.ord = index;
	});
	return blocks;
}

function blockOf(blocks: DomBlock[], node: Node): DomBlock | null {
	let current: Element | null =
		node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	while (current) {
		const found = blocks.find((block) => block.element === current);
		if (found) return found;
		current = current.parentElement;
	}
	return null;
}

/**
 * Number of normalized code points that end at or before `(node, offset)`
 * inside `block` — i.e. the [start, end) boundary at this DOM position.
 * Returns null when the position is outside the block or splits a code point.
 */
function boundaryIndex(block: DomBlock, node: Node, offset: number): number | null {
	if (!block.element.contains(node)) return null;
	const probe = document.createRange();
	try {
		probe.setStart(node, offset);
	} catch {
		return null;
	}
	let index = 0;
	for (const point of block.points) {
		const end = point.offset + point.length;
		// A range that ends inside a surrogate pair cannot be compared reliably.
		if (end > point.node.data.length) return null;
		const relation = probe.comparePoint(point.node, end);
		if (relation === 1) break;
		index += 1;
	}
	return index;
}

/**
 * Map the current DOM selection to an anchor draft, or null when it is not a
 * legal segment selection (collapsed, cross-block, inside a void subtree,
 * too short/long, or outside `root`).
 *
 * `blocks` is passed in so a caller that already collected the article does not
 * pay for a second walk on every selection change.
 */
export function selectionToAnchor(
	root: HTMLElement,
	selection: Selection,
	blocks: DomBlock[] = collectDomBlocks(root)
): SegmentSelection | null {
	if (selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;

	const startBlock = blockOf(blocks, range.startContainer);
	const endBlock = blockOf(blocks, range.endContainer);
	// Cross-block selections are a registered v1 rejection (spec §2).
	if (!startBlock || startBlock !== endBlock) return null;
	if (
		insideSkipped(range.startContainer, startBlock.element) ||
		insideSkipped(range.endContainer, startBlock.element)
	) {
		return null;
	}

	const start = boundaryIndex(startBlock, range.startContainer, range.startOffset);
	const end = boundaryIndex(startBlock, range.endContainer, range.endOffset);
	if (start === null || end === null) return null;
	const length = end - start;
	if (length < ANCHOR_MIN_LENGTH || length > ANCHOR_MAX_LENGTH) return null;

	const exact = codePointSlice(startBlock.text, start, end);
	if (!exact.trim()) return null;

	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;

	return { ord: startBlock.ord, start, end, exact, rect };
}

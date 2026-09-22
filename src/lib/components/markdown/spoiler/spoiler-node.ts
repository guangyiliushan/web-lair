import {
	TextNode,
	addClassNamesToElement,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

export type SerializedSpoilerNode = SerializedTextNode & { type: 'spoiler' };

/**
 * SpoilerNode - `||x||` (spec 2 #6) as an inline node.
 *
 * Deliberately NOT a token: the text inside a spoiler must stay editable (a
 * token would forbid the caret inside it). The DOM class matches the render
 * side's `.spoiler` span so one CSS rule (the same-color mask in layout.css)
 * drives both the editor and the published page.
 */
export class SpoilerNode extends TextNode {
	static getType(): string {
		return 'spoiler';
	}

	static clone(node: SpoilerNode): SpoilerNode {
		return new SpoilerNode(node.__text, node.__key);
	}

	constructor(text: string, key?: NodeKey) {
		super(text, key);
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		addClassNamesToElement(dom, 'spoiler');
		dom.title = this.__text;
		return dom;
	}

	updateDOM(prev: this, dom: HTMLElement, config: EditorConfig): boolean {
		// super owns the text/format DOM sync; skipping it froze the DOM on
		// in-place edits (batch A review, F2). Only the class is re-asserted.
		const updated = super.updateDOM(prev, dom, config);
		addClassNamesToElement(dom, 'spoiler');
		if (dom.title !== this.__text) dom.title = this.__text;
		return updated;
	}

	static importDOM(): DOMConversionMap | null {
		return {
			span: (node) => {
				const element = node as HTMLElement;
				if (!element.classList.contains('spoiler')) return null;
				return {
					conversion: (domNode) => ({
						node: $createSpoilerNode((domNode as HTMLElement).textContent ?? '')
					}),
					priority: 0
				};
			}
		};
	}

	exportJSON(): SerializedSpoilerNode {
		return {
			...super.exportJSON(),
			type: 'spoiler'
		};
	}

	static importJSON(serialized: SerializedSpoilerNode): SpoilerNode {
		return $createSpoilerNode(serialized.text ?? '');
	}
}

export function $createSpoilerNode(text: string): SpoilerNode {
	return new SpoilerNode(text);
}

export function $isSpoilerNode(node: unknown): node is SpoilerNode {
	return node instanceof SpoilerNode;
}

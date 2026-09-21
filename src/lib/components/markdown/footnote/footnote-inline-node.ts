import {
	TextNode,
	addClassNamesToElement,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

export type SerializedFootnoteInlineNode = SerializedTextNode & { type: 'footnote-inline' };

/**
 * FootnoteInlineNode - `^[inline text]` (pandoc-style inline footnote) as an
 * atomic inline chip. Raw source form is stored (round-trip pass-through).
 */
export class FootnoteInlineNode extends TextNode {
	static getType(): string {
		return 'footnote-inline';
	}

	static clone(node: FootnoteInlineNode): FootnoteInlineNode {
		return new FootnoteInlineNode(node.__text, node.__key);
	}

	constructor(text: string, key?: NodeKey) {
		super(text, key);
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		addClassNamesToElement(dom, 'rich-editor-footnote-inline');
		return dom;
	}

	updateDOM(prev: this, dom: HTMLElement, config: EditorConfig): boolean {
		const updated = super.updateDOM(prev, dom, config);
		addClassNamesToElement(dom, 'rich-editor-footnote-inline');
		return updated;
	}

	static importDOM(): DOMConversionMap | null {
		return {
			span: (node) => {
				const element = node as HTMLElement;
				if (!element.classList.contains('rich-editor-footnote-inline')) return null;
				return {
					conversion: (domNode) => ({
						node: $createFootnoteInlineNode((domNode as HTMLElement).textContent ?? '')
					}),
					priority: 0
				};
			}
		};
	}

	exportJSON(): SerializedFootnoteInlineNode {
		return {
			...super.exportJSON(),
			type: 'footnote-inline'
		};
	}

	static importJSON(serialized: SerializedFootnoteInlineNode): FootnoteInlineNode {
		return $createFootnoteInlineNode(serialized.text ?? '');
	}

	isToken(): boolean {
		return true;
	}
}

export function $createFootnoteInlineNode(text: string): FootnoteInlineNode {
	return new FootnoteInlineNode(text);
}

export function $isFootnoteInlineNode(node: unknown): node is FootnoteInlineNode {
	return node instanceof FootnoteInlineNode;
}

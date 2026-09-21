import {
	TextNode,
	addClassNamesToElement,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

export type SerializedFootnoteRefNode = SerializedTextNode & { type: 'footnote-ref' };

/**
 * FootnoteRefNode - `[^label]` (L1 GFM footnotes) as an atomic inline chip.
 *
 * The stored text is the raw source form (`[^label]`), so export is a plain
 * pass-through and the definition line `[^label]: ...` never matches (the
 * transformer blocks the trailing colon). Token semantics: the label cannot
 * be edited piecemeal, mirroring mention/tag.
 */
export class FootnoteRefNode extends TextNode {
	static getType(): string {
		return 'footnote-ref';
	}

	static clone(node: FootnoteRefNode): FootnoteRefNode {
		return new FootnoteRefNode(node.__text, node.__key);
	}

	constructor(text: string, key?: NodeKey) {
		super(text, key);
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		addClassNamesToElement(dom, 'rich-editor-footnote-ref');
		return dom;
	}

	updateDOM(prev: this, dom: HTMLElement, config: EditorConfig): boolean {
		const updated = super.updateDOM(prev, dom, config);
		addClassNamesToElement(dom, 'rich-editor-footnote-ref');
		return updated;
	}

	static importDOM(): DOMConversionMap | null {
		return {
			span: (node) => {
				const element = node as HTMLElement;
				if (!element.classList.contains('rich-editor-footnote-ref')) return null;
				return {
					conversion: (domNode) => ({
						node: $createFootnoteRefNode((domNode as HTMLElement).textContent ?? '')
					}),
					priority: 0
				};
			}
		};
	}

	exportJSON(): SerializedFootnoteRefNode {
		return {
			...super.exportJSON(),
			type: 'footnote-ref'
		};
	}

	static importJSON(serialized: SerializedFootnoteRefNode): FootnoteRefNode {
		return $createFootnoteRefNode(serialized.text ?? '');
	}

	// Atomic: the caret cannot enter, mirroring mention/tag.
	isToken(): boolean {
		return true;
	}
}

export function $createFootnoteRefNode(text: string): FootnoteRefNode {
	return new FootnoteRefNode(text);
}

export function $isFootnoteRefNode(node: unknown): node is FootnoteRefNode {
	return node instanceof FootnoteRefNode;
}

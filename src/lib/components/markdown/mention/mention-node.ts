import {
	TextNode,
	addClassNamesToElement,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

export type SerializedMentionNode = SerializedTextNode & { type: 'mention' };

/**
 * MentionNode - `@gh:user` / `@tw:user` / `@tg:user` (spec 2 #4) as an
 * atomic inline badge.
 *
 * Token semantics like the tag node: the caret never lands inside a mention,
 * so the platform prefix and username cannot be edited piecemeal (the text
 * stays exactly what the render side tokenises). The DOM class matches the
 * render side's `.mention` anchor so the same CSS applies to both.
 */
export class MentionNode extends TextNode {
	static getType(): string {
		return 'mention';
	}

	static clone(node: MentionNode): MentionNode {
		return new MentionNode(node.__text, node.__key);
	}

	constructor(text: string, key?: NodeKey) {
		super(text, key);
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		addClassNamesToElement(dom, 'mention');
		return dom;
	}

	updateDOM(prev: this, dom: HTMLElement, config: EditorConfig): boolean {
		// super owns the text/format DOM sync (batch A review, F2).
		const updated = super.updateDOM(prev, dom, config);
		addClassNamesToElement(dom, 'mention');
		return updated;
	}

	static importDOM(): DOMConversionMap | null {
		return {
			span: (node) => {
				const element = node as HTMLElement;
				if (!element.classList.contains('mention')) return null;
				return {
					conversion: (domNode) => ({
						node: $createMentionNode((domNode as HTMLElement).textContent ?? '')
					}),
					priority: 0
				};
			},
			a: (node) => {
				const element = node as HTMLElement;
				// render-side form: <a class="mention" href="@gh:x">
				if (!element.classList.contains('mention')) return null;
				return {
					conversion: (domNode) => ({
						node: $createMentionNode((domNode as HTMLElement).textContent ?? '')
					}),
					priority: 1
				};
			}
		};
	}

	exportJSON(): SerializedMentionNode {
		return {
			...super.exportJSON(),
			type: 'mention'
		};
	}

	static importJSON(serialized: SerializedMentionNode): MentionNode {
		return $createMentionNode(serialized.text ?? '');
	}

	// Atomic: the caret cannot enter, mirroring the tag node.
	isToken(): boolean {
		return true;
	}
}

export function $createMentionNode(text: string): MentionNode {
	return new MentionNode(text);
}

export function $isMentionNode(node: unknown): node is MentionNode {
	return node instanceof MentionNode;
}

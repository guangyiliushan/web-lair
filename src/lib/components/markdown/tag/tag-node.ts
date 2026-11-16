import {
	TextNode,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

/** Generate a stable background colour for the tag text */
function tagBgColor(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = text.charCodeAt(i) + ((hash << 5) - hash);
	}
	// Soft tone ranges (green / blue / purple)
	const palettes = [
		[171, 214, 158], // 绿
		[158, 190, 214], // 蓝
		[214, 158, 200], // 粉紫
		[214, 200, 158], // 金
		[158, 214, 200] // 青
	];
	const [r, g, b] = palettes[Math.abs(hash) % palettes.length];
	return `rgba(${r},${g},${b},0.7)`;
}

export type SerializedTagNode = SerializedTextNode & { type: 'tag' };

export class TagNode extends TextNode {
	static getType(): string {
		return 'tag';
	}

	static clone(node: TagNode): TagNode {
		return new TagNode(node.__text, node.__key);
	}

	constructor(text: string, key?: NodeKey) {
		super(text, key);
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		dom.className = 'rich-editor-tag';
		dom.style.backgroundColor = tagBgColor(this.__text);
		return dom;
	}

	updateDOM(prev: TagNode, dom: HTMLElement): boolean {
		// The TagNode text is mutable, so the colour follows text updates
		dom.style.backgroundColor = tagBgColor(this.__text);
		return false; // false = Lexical 不替我们更新 DOM，我们已处理
	}

	static importDOM(): DOMConversionMap | null {
		return {
			// render-side form: the <tag> inline element (4.5 whitelist)
			tag: () => {
				return {
					conversion: (element) => {
						const text = element.textContent ?? '';
						const tagNode = $createTagNode(text);
						return { node: tagNode };
					},
					priority: 1
				};
			},
			// Compatible with the legacy exported internal editor shape span.rich-editor-tag
			span: (node) => {
				const el = node as HTMLElement;
				if (el.classList.contains('rich-editor-tag')) {
					return {
						conversion: (element) => {
							const text = element.textContent ?? '';
							const tagNode = $createTagNode(text);
							return { node: tagNode };
						},
						priority: 0
					};
				}
				return null;
			}
		};
	}

	exportJSON(): SerializedTagNode {
		return {
			...super.exportJSON(),
			type: 'tag'
		};
	}

	static importJSON(serialized: SerializedTagNode): TagNode {
		return $createTagNode(serialized.text ?? '');
	}

	// A tag is not splittable (the cursor cannot enter it to edit a single character)
	isToken(): boolean {
		return true;
	}
}

/** $-prefixed factory for TagNode */
export function $createTagNode(text: string): TagNode {
	return new TagNode(text);
}

/** Whether the node is a TagNode */
export function $isTagNode(node: unknown): node is TagNode {
	return node instanceof TagNode;
}

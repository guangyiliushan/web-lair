import {
	TextNode,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode
} from 'lexical';

/** 为 tag 文本生成稳定的背景色 */
function tagBgColor(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = text.charCodeAt(i) + ((hash << 5) - hash);
	}
	// 使用柔和的色调范围（绿色系/蓝色系/紫色系）
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
		// TagNode 文本可变，颜色随文本更新
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
			// 兼容旧导出的编辑器内部形态 span.rich-editor-tag
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

	// Tag 不可拆分（光标不能进入 tag 中间修改单个字符）
	isToken(): boolean {
		return true;
	}
}

/** 创建 TagNode 的 $ 前缀工厂函数 */
export function $createTagNode(text: string): TagNode {
	return new TagNode(text);
}

/** 判断节点是否为 TagNode */
export function $isTagNode(node: unknown): node is TagNode {
	return node instanceof TagNode;
}

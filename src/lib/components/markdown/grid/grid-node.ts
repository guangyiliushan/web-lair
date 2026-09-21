import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import GridDecorator from './grid-decorator.svelte';
import { createDefaultAlertContent } from '$lib/components/markdown/alert/alert-types';

export interface SerializedGridNode extends SerializedLexicalNode {
	type: 'grid';
	/** Raw brace content as written in the source; '' when there were no braces. */
	rawAttrs: string;
	cols: number;
	rows: number | null;
	gap: number;
	layout: 'grid' | 'masonry' | 'carousel';
	imageType: 'normal' | 'images';
	explicitKeys: string[];
	jsonContent: string;
}

/**
 * GridNode - the `:::grid {cols gap layout type}` container (spec 3.2). The
 * body lives in a nested editor whose direct children are laid out by CSS
 * (grid / masonry / carousel) driven by the node's parameters.
 */
export class GridNode extends DecoratorNode<HTMLElement> {
	__rawAttrs: string;
	__cols: number;
	__rows: number | null;
	__gap: number;
	__layout: 'grid' | 'masonry' | 'carousel';
	__imageType: 'normal' | 'images';
	__explicitKeys: string[];
	__jsonContent: string;

	static getType(): string {
		return 'grid';
	}

	static clone(node: GridNode): GridNode {
		return new GridNode(
			node.__rawAttrs,
			node.__cols,
			node.__rows,
			node.__gap,
			node.__layout,
			node.__imageType,
			node.__explicitKeys,
			node.__jsonContent,
			node.__key
		);
	}

	constructor(
		rawAttrs = '',
		cols = 3,
		rows: number | null = null,
		gap = 8,
		layout: 'grid' | 'masonry' | 'carousel' = 'grid',
		imageType: 'normal' | 'images' = 'normal',
		explicitKeys: string[] = [],
		jsonContent?: string,
		key?: NodeKey
	) {
		super(key);
		this.__rawAttrs = rawAttrs;
		this.__cols = cols;
		this.__rows = rows;
		this.__gap = gap;
		this.__layout = layout;
		this.__imageType = imageType;
		this.__explicitKeys = explicitKeys;
		this.__jsonContent = jsonContent ?? createDefaultAlertContent();
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-grid-host';
		div.contentEditable = 'false';
		return div;
	}

	updateDOM(): boolean {
		return false;
	}

	isInline(): boolean {
		return false;
	}

	isKeyboardSelectable(): boolean {
		return true;
	}

	getRawAttrs(): string {
		return this.__rawAttrs;
	}

	getExplicitKeys(): string[] {
		return this.__explicitKeys;
	}

	getJsonContent(): string {
		return this.__jsonContent;
	}

	setJsonContent(json: string): void {
		this.getWritable().__jsonContent = json;
	}

	exportJSON(): SerializedGridNode {
		return {
			...super.exportJSON(),
			type: 'grid',
			rawAttrs: this.__rawAttrs,
			cols: this.__cols,
			rows: this.__rows,
			gap: this.__gap,
			layout: this.__layout,
			imageType: this.__imageType,
			explicitKeys: this.__explicitKeys,
			jsonContent: this.__jsonContent
		};
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): GridNode {
		const s = serialized as unknown as SerializedGridNode;
		return new GridNode(
			s.rawAttrs ?? '',
			s.cols ?? 3,
			s.rows ?? null,
			s.gap ?? 8,
			s.layout ?? 'grid',
			s.imageType ?? 'normal',
			s.explicitKeys ?? [],
			s.jsonContent
		);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		mountDecorator(
			this,
			GridDecorator,
			container,
			{
				nodeKey: this.__key,
				cols: this.__cols,
				gap: this.__gap,
				layout: this.__layout,
				imageType: this.__imageType,
				initialContent: this.__jsonContent,
				parentEditor: editor
			},
			'⚠ 网格容器加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}
}

export function $createGridNode(
	rawAttrs: string,
	cols: number,
	rows: number | null,
	gap: number,
	layout: 'grid' | 'masonry' | 'carousel',
	imageType: 'normal' | 'images',
	explicitKeys: string[],
	jsonContent: string
): GridNode {
	return new GridNode(rawAttrs, cols, rows, gap, layout, imageType, explicitKeys, jsonContent);
}

export function $isGridNode(node: unknown): node is GridNode {
	return node instanceof GridNode;
}

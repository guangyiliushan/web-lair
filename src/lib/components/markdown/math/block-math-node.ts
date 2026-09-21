import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { dispatchMathEdit, scheduleKatexRender } from './math-render';

export type SerializedBlockMathNode = SerializedLexicalNode & {
	type: 'block-math';
	latex: string;
};

/**
 * BlockMathNode - a standalone `$$x$$` paragraph (spec 2 #2) rendered with
 * KaTeX in display mode. One-line source only: the multiline `$$ ... $$`
 * form is not imported as a node (registered follow-up); note the core
 * exporter still rewrites such blocks on save, so they are not byte-stable.
 */
export class BlockMathNode extends DecoratorNode<HTMLElement> {
	__latex: string;

	static getType(): string {
		return 'block-math';
	}

	static clone(node: BlockMathNode): BlockMathNode {
		return new BlockMathNode(node.__latex, node.__key);
	}

	constructor(latex: string, key?: NodeKey) {
		super(key);
		this.__latex = latex;
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-math-block';
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

	getLatex(): string {
		return this.__latex;
	}

	setLatex(latex: string): void {
		this.getWritable().__latex = latex;
	}

	getTextContent(): string {
		return '$$' + this.__latex + '$$';
	}

	exportJSON(): SerializedBlockMathNode {
		return {
			...super.exportJSON(),
			type: 'block-math',
			latex: this.__latex
		};
	}

	static importJSON(serialized: SerializedBlockMathNode): BlockMathNode {
		return new BlockMathNode(serialized.latex);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		container.className = 'rich-editor-math-block-inner';
		scheduleKatexRender(container, this.__latex, true);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
			// click on the whole host, including its padding hot zone;
			// property assignment keeps re-decorates idempotent (no listener leak)
			hostEl.onclick = () => {
				dispatchMathEdit(editor, this.getKey());
			};
		}
		return container;
	}
}

export function $createBlockMathNode(latex: string): BlockMathNode {
	return new BlockMathNode(latex);
}

export function $isBlockMathNode(node: unknown): node is BlockMathNode {
	return node instanceof BlockMathNode;
}

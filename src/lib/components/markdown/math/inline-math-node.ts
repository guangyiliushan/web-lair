import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { dispatchMathEdit, scheduleKatexRender } from './math-render';

/** Source notation of an inline math node, preserved across save (spec 2 #2). */
export type MathForm = 'dollar' | 'paren';

export type SerializedInlineMathNode = SerializedLexicalNode & {
	type: 'inline-math';
	latex: string;
	form: MathForm;
};

/**
 * InlineMathNode - `$x$` / `\(x\)` (spec 2 #2) rendered with KaTeX.
 *
 * The node keeps the original notation: a document that used `\(...\)` round
 * trips unchanged instead of being rewritten to `$...$` (the render pipeline
 * treats both as equivalent).
 */
export class InlineMathNode extends DecoratorNode<HTMLElement> {
	__latex: string;
	__form: MathForm;

	static getType(): string {
		return 'inline-math';
	}

	static clone(node: InlineMathNode): InlineMathNode {
		return new InlineMathNode(node.__latex, node.__form, node.__key);
	}

	constructor(latex: string, form: MathForm = 'dollar', key?: NodeKey) {
		super(key);
		this.__latex = latex;
		this.__form = form;
	}

	createDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'rich-editor-math';
		span.contentEditable = 'false';
		return span;
	}

	updateDOM(): boolean {
		return false;
	}

	isInline(): boolean {
		return true;
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
		return this.__form === 'paren' ? '\\(' + this.__latex + '\\)' : '$' + this.__latex + '$';
	}

	exportJSON(): SerializedInlineMathNode {
		return {
			...super.exportJSON(),
			type: 'inline-math',
			latex: this.__latex,
			form: this.__form
		};
	}

	static importJSON(serialized: SerializedInlineMathNode): InlineMathNode {
		return new InlineMathNode(serialized.latex, serialized.form);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('span');
		container.className = 'rich-editor-math-inner';
		scheduleKatexRender(container, this.__latex, false);
		// Lexical 0.46 does not attach decorate()'s return value by itself;
		// mount into the host element created by createDOM() (AlertNode pattern).
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

export function $createInlineMathNode(latex: string, form: MathForm = 'dollar'): InlineMathNode {
	return new InlineMathNode(latex, form);
}

export function $isInlineMathNode(node: unknown): node is InlineMathNode {
	return node instanceof InlineMathNode;
}

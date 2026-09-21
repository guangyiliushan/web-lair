import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { scheduleMermaidRender } from './mermaid-client';

export interface SerializedMermaidNode extends SerializedLexicalNode {
	type: 'mermaid';
	source: string;
}

/**
 * MermaidNode - a block-level ```mermaid fence (spec 3.3) rendered to SVG in
 * the editor through the same execution client the published page uses
 * (lazy import, strict sandbox, fixpoint config stripping, raw-source
 * rollback on failure). Export recreates the fence verbatim.
 */
export class MermaidNode extends DecoratorNode<HTMLElement> {
	__source: string;

	static getType(): string {
		return 'mermaid';
	}

	static clone(node: MermaidNode): MermaidNode {
		return new MermaidNode(node.__source, node.__key);
	}

	constructor(source: string, key?: NodeKey) {
		super(key);
		this.__source = source;
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-mermaid-host';
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

	getSource(): string {
		return this.__source;
	}

	exportJSON(): SerializedMermaidNode {
		return {
			...super.exportJSON(),
			type: 'mermaid',
			source: this.__source
		};
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): MermaidNode {
		const s = serialized as unknown as SerializedMermaidNode;
		return new MermaidNode(s.source);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		container.className = 'mermaid';
		container.textContent = this.__source;
		// The execution client archives the source on data-md-source, renders
		// the SVG and rolls back to the raw text on failure. A blank source
		// skips the render: mermaid logs an error-level noise for it.
		if (this.__source.trim()) {
			scheduleMermaidRender([container]);
		}

		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}
}

export function $createMermaidNode(source: string): MermaidNode {
	return new MermaidNode(source);
}

export function $isMermaidNode(node: unknown): node is MermaidNode {
	return node instanceof MermaidNode;
}

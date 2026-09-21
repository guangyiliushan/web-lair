import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import DetailsDecorator from './details-decorator.svelte';
import { createDefaultAlertContent } from '$lib/components/markdown/alert/alert-types';

export type DetailsVariant = 'details' | 'spoiler';

export interface SerializedDetailsNode extends SerializedLexicalNode {
	type: 'details';
	variant: DetailsVariant;
	/** Raw brace content as written in the source; '' when there were no braces. */
	rawAttrs: string;
	summary: string;
	summaryExplicit: boolean;
	open: boolean;
	jsonContent: string;
}

const DEFAULT_SUMMARY: Record<DetailsVariant, string> = {
	details: '详情',
	spoiler: '剧透'
};

/**
 * DetailsNode - the `:::details summary="…" [open]` / `:::spoiler label="…"`
 * containers (spec 3.2) rendered with the same collapse semantics the
 * published page gets. The body lives in a nested editor (AlertNode pattern).
 */
export class DetailsNode extends DecoratorNode<HTMLElement> {
	__variant: DetailsVariant;
	__rawAttrs: string;
	__summary: string;
	__summaryExplicit: boolean;
	__open: boolean;
	__jsonContent: string;

	static getType(): string {
		return 'details';
	}

	static clone(node: DetailsNode): DetailsNode {
		return new DetailsNode(
			node.__variant,
			node.__rawAttrs,
			node.__summary,
			node.__summaryExplicit,
			node.__open,
			node.__jsonContent,
			node.__key
		);
	}

	constructor(
		variant: DetailsVariant = 'details',
		rawAttrs = '',
		summary = '',
		summaryExplicit = false,
		open = false,
		jsonContent?: string,
		key?: NodeKey
	) {
		super(key);
		this.__variant = variant;
		this.__rawAttrs = rawAttrs;
		this.__summary = summary;
		this.__summaryExplicit = summaryExplicit;
		this.__open = open;
		this.__jsonContent = jsonContent ?? createDefaultAlertContent();
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-details-host';
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

	getVariant(): DetailsVariant {
		return this.__variant;
	}

	getSummary(): string {
		return this.__summary || DEFAULT_SUMMARY[this.__variant];
	}

	isSummaryExplicit(): boolean {
		return this.__summaryExplicit;
	}

	isOpen(): boolean {
		return this.__open;
	}

	setOpen(open: boolean): void {
		this.getWritable().__open = open;
	}

	setJsonContent(json: string): void {
		this.getWritable().__jsonContent = json;
	}

	exportJSON(): SerializedDetailsNode {
		return {
			...super.exportJSON(),
			type: 'details',
			variant: this.__variant,
			rawAttrs: this.__rawAttrs,
			summary: this.__summary,
			summaryExplicit: this.__summaryExplicit,
			open: this.__open,
			jsonContent: this.__jsonContent
		};
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): DetailsNode {
		const s = serialized as unknown as SerializedDetailsNode;
		return new DetailsNode(
			s.variant,
			s.rawAttrs ?? '',
			s.summary ?? '',
			s.summaryExplicit ?? false,
			s.open ?? false,
			s.jsonContent
		);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		mountDecorator(
			this,
			DetailsDecorator,
			container,
			{
				nodeKey: this.__key,
				variant: this.__variant,
				summary: this.getSummary(),
				open: this.__open,
				initialContent: this.__jsonContent,
				parentEditor: editor
			},
			'⚠ 详情容器加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}
}

export function $createDetailsNode(
	variant: DetailsVariant,
	rawAttrs: string,
	summary: string,
	summaryExplicit: boolean,
	open: boolean,
	jsonContent: string
): DetailsNode {
	return new DetailsNode(variant, rawAttrs, summary, summaryExplicit, open, jsonContent);
}

export function $isDetailsNode(node: unknown): node is DetailsNode {
	return node instanceof DetailsNode;
}

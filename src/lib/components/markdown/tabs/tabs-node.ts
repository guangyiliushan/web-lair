import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import TabsDecorator from './tabs-decorator.svelte';
import { createDefaultAlertContent } from '$lib/components/markdown/alert/alert-types';

export interface SerializedTabEntry {
	label: string;
	labelExplicit: boolean;
	jsonContent: string;
}

export interface SerializedTabsNode extends SerializedLexicalNode {
	type: 'tabs';
	tabs: SerializedTabEntry[];
}

/**
 * TabsNode - the `:::tabs` container with `:::tab label="…"` children
 * (spec 3.2). Tab bodies live as nested-editor JSON; the active panel's
 * editor is mounted at a time (the others stay as JSON).
 */
export class TabsNode extends DecoratorNode<HTMLElement> {
	__tabs: SerializedTabEntry[];

	static getType(): string {
		return 'tabs';
	}

	static clone(node: TabsNode): TabsNode {
		return new TabsNode(
			node.__tabs.map((t) => ({
				label: t.label,
				labelExplicit: t.labelExplicit,
				jsonContent: t.jsonContent
			})),
			node.__key
		);
	}

	constructor(tabs: SerializedTabEntry[], key?: NodeKey) {
		super(key);
		this.__tabs =
			tabs.length > 0
				? tabs
				: [{ label: '标签一', labelExplicit: false, jsonContent: createDefaultAlertContent() }];
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-tabs-host';
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

	getTabs(): SerializedTabEntry[] {
		return this.__tabs;
	}

	setTabJson(index: number, json: string): void {
		// non-dirty read first: getWritable() alone marks the node dirty and
		// would form a decorate/debounced-writer loop
		const current = this.__tabs[index];
		if (!current || current.jsonContent === json) return;
		this.getWritable().__tabs[index].jsonContent = json;
	}

	exportJSON(): SerializedTabsNode {
		return {
			...super.exportJSON(),
			type: 'tabs',
			tabs: this.__tabs.map((tab) => ({ ...tab }))
		};
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): TabsNode {
		const s = serialized as unknown as SerializedTabsNode;
		return new TabsNode(Array.isArray(s.tabs) ? s.tabs : []);
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		mountDecorator(
			this,
			TabsDecorator,
			container,
			{
				nodeKey: this.__key,
				tabs: this.__tabs.map((t) => ({ label: t.label, jsonContent: t.jsonContent })),
				parentEditor: editor
			},
			'⚠ 标签页容器加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}
}

export function $createTabsNode(tabs: SerializedTabEntry[]): TabsNode {
	return new TabsNode(tabs);
}

export function $isTabsNode(node: unknown): node is TabsNode {
	return node instanceof TabsNode;
}

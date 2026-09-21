import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import AlertDecorator from './alert-decorator.svelte';
import { DEFAULT_ALERT_TYPE, createDefaultAlertContent } from './alert-types';
import type { AlertType } from './alert-types';

export interface SerializedAlertNode extends SerializedLexicalNode {
	type: 'alert';
	alertType: AlertType;
	title: string;
	jsonContent: string;
}

export class AlertNode extends DecoratorNode<HTMLElement> {
	__alertType: AlertType;
	__title: string;
	__jsonContent: string;

	constructor(
		alertType: AlertType = DEFAULT_ALERT_TYPE,
		jsonContent?: string,
		title = '',
		key?: NodeKey
	) {
		super(key);
		this.__alertType = alertType;
		this.__jsonContent = jsonContent ?? createDefaultAlertContent();
		this.__title = title;
	}

	static getType(): string {
		return 'alert';
	}

	static clone(node: AlertNode): AlertNode {
		return new AlertNode(node.__alertType, node.__jsonContent, node.__title, node.__key);
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): AlertNode {
		const s = serialized as unknown as SerializedAlertNode;
		return new AlertNode(s.alertType, s.jsonContent, s.title ?? '');
	}

	exportJSON(): SerializedAlertNode {
		return {
			...super.exportJSON(),
			type: 'alert',
			alertType: this.__alertType,
			title: this.__title,
			jsonContent: this.__jsonContent
		};
	}

	// ── DOM ──
	// 签名：createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement
	createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement {
		void config;
		void editor;
		const div = document.createElement('div');
		div.className = 'rich-editor-alert-host';
		div.contentEditable = 'false';
		return div;
	}

	// 签名：updateDOM(prevNode: DecoratorNode<HTMLElement>, dom: HTMLElement, config: EditorConfig): boolean
	updateDOM(): boolean {
		return false;
	}

	// ── Decorator ──
	// 签名：decorate(editor: LexicalEditor, config: EditorConfig): null | HTMLElement
	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		mountDecorator(
			this,
			AlertDecorator,
			container,
			{
				nodeKey: this.__key,
				alertType: this.__alertType,
				title: this.__title,
				initialContent: this.__jsonContent,
				parentEditor: editor
			},
			'⚠ 告警组件加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}

	// ── 行为 ──
	isInline(): boolean {
		return false;
	}

	isKeyboardSelectable(): boolean {
		return true;
	}

	// ── 数据写回 ──
	setAlertType(type: AlertType): void {
		this.getWritable().__alertType = type;
	}

	setJsonContent(json: string): void {
		this.getWritable().__jsonContent = json;
	}
}

export function $createAlertNode(type?: AlertType, content?: string, title?: string): AlertNode {
	return new AlertNode(type, content, title);
}

export function $isAlertNode(node: unknown): node is AlertNode {
	return node instanceof AlertNode;
}

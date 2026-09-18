import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mount, unmount } from 'svelte';
import AlertDecorator from './alert-decorator.svelte';
import { DEFAULT_ALERT_TYPE, createDefaultAlertContent } from './alert-types';
import type { AlertType } from './alert-types';

type MountedDecoratorHandle = Record<string, unknown>;

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
	/** @internal Svelte 组件句柄，不参与序列化 */
	__svelteComp: MountedDecoratorHandle | null = null;

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
		// 先清理旧的 Svelte 组件（节点更新时 decorate 会被重新调用）
		if (this.__svelteComp) {
			try {
				unmount(this.__svelteComp);
			} catch {
				// 忽略清理错误
			}
			this.__svelteComp = null;
		}

		const container = document.createElement('div');
		try {
			this.__svelteComp = mount(AlertDecorator, {
				target: container,
				props: {
					nodeKey: this.__key,
					alertType: this.__alertType,
					title: this.__title,
					initialContent: this.__jsonContent,
					parentEditor: editor
				},
				intro: false
			});
		} catch (e) {
			console.error('AlertNode: failed to mount Svelte decorator', e);
			container.textContent = '⚠ Alert 组件加载失败，按 Backspace 删除此块';
			container.className = 'rich-editor-alert rich-editor-alert-error';
		}

		// Lexical 0.46 的默认 DOM 配置不会自动把 decorate() 的返回值接入 DOM，
		// 需要手动查找 host 元素并挂载。
		// 注意：decorate() 调用时 createDOM() 返回的 host div 已在编辑器 DOM 中。
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			// 清空旧的 decoration 内容
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

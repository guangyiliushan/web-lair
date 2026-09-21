import {
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import EmbedCard from './EmbedCard.svelte';
import type { EmbedProviderId } from './registry';

export interface SerializedEmbedNode extends SerializedLexicalNode {
	type: 'embed';
	url: string;
	title: string;
	provider: EmbedProviderId | 'generic';
	/** Raw tail-attribute text (spec 2 #7), re-emitted verbatim on export. */
	tail: string;
}

/**
 * EmbedNode - a block-level `![title](url)` card (spec 3.4) rendered with the
 * same EmbedCard component the published page mounts, so the editor preview
 * matches the article. The node stores the decision made by `decideImage`
 * (pure, no network); export recreates the original image syntax.
 */
export class EmbedNode extends DecoratorNode<HTMLElement> {
	__url: string;
	__title: string;
	__provider: EmbedProviderId | 'generic';
	__tail: string;

	static getType(): string {
		return 'embed';
	}

	static clone(node: EmbedNode): EmbedNode {
		return new EmbedNode(node.__url, node.__title, node.__provider, node.__tail, node.__key);
	}

	constructor(
		url: string,
		title: string,
		provider: EmbedProviderId | 'generic',
		tail = '',
		key?: NodeKey
	) {
		super(key);
		this.__url = url;
		this.__title = title;
		this.__provider = provider;
		this.__tail = tail;
	}

	createDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'rich-editor-embed-host';
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

	getUrl(): string {
		return this.__url;
	}

	getTitle(): string {
		return this.__title;
	}

	getProvider(): EmbedProviderId | 'generic' {
		return this.__provider;
	}

	getTail(): string {
		return this.__tail;
	}

	exportJSON(): SerializedEmbedNode {
		return {
			...super.exportJSON(),
			type: 'embed',
			url: this.__url,
			title: this.__title,
			provider: this.__provider,
			tail: this.__tail
		};
	}

	static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): EmbedNode {
		const s = serialized as unknown as SerializedEmbedNode;
		return new EmbedNode(s.url, s.title, s.provider, s.tail ?? '');
	}

	decorate(editor: LexicalEditor, config: EditorConfig): HTMLElement {
		void config;
		const container = document.createElement('div');
		mountDecorator(
			this,
			EmbedCard,
			container,
			{
				provider: this.__provider,
				url: this.__url,
				title: this.__title
			},
			'⚠ 嵌入卡加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
		}
		return container;
	}
}

export function $createEmbedNode(
	url: string,
	title: string,
	provider: EmbedProviderId | 'generic',
	tail = ''
): EmbedNode {
	return new EmbedNode(url, title, provider, tail);
}

export function $isEmbedNode(node: unknown): node is EmbedNode {
	return node instanceof EmbedNode;
}

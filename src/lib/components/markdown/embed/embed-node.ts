import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	DecoratorNode,
	type EditorConfig,
	type LexicalEditor,
	type NodeKey,
	type SerializedLexicalNode
} from 'lexical';
import { mountDecorator } from '$lib/components/markdown/editor/decorator-mount';
import EmbedCard from './EmbedCard.svelte';
import { resolveProviderId, type EmbedProviderId } from './registry';

// ── 组件级选中(编辑器内的嵌入卡)──
//
// 为什么不用 Lexical NodeSelection:装饰器点击后 DOM selection 为空,
// 而 Lexical 的 selection 重建路径($internalCreateRangeSelection)在普通
// update 中会用 DOM selection 覆盖非 Range 选区(空 DOM 选区 → null,
// Lexical.dev.mjs `$internalCreateRangeSelection` 的 useDOMSelection 分支)
// ——NodeSelection 在此场景 inherently 不稳。组件级标记(`data-selected`)
// 不进 Lexical 选区系统,行为可控可测;键盘方向键的 isKeyboardSelectable
// 路径保留给 Lexical 自己(与点击路径互不干扰)。

let selectedHost: HTMLElement | null = null;

function clearEmbedSelection(): void {
	if (selectedHost) selectedHost.removeAttribute('data-selected');
	selectedHost = null;
}

/** 点击=选中(互斥),Backspace/Delete=删除节点,点击他处=清除。 */
function attachEmbedSelection(editor: LexicalEditor, hostEl: HTMLElement, key: NodeKey): void {
	hostEl.addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		// 编辑行控件放行(preventDefault 会连带阻止 input 聚焦)
		if (target?.closest('.embed-edit-row, .embed-edit, input')) return;
		// 拦截卡内链接/façade 在编辑器内的默认导航
		event.preventDefault();
		clearEmbedSelection();
		selectedHost = hostEl;
		hostEl.setAttribute('data-selected', 'true');
	});

	const onDocKeydown = (event: KeyboardEvent): void => {
		if (!hostEl.isConnected) {
			document.removeEventListener('keydown', onDocKeydown, true);
			document.removeEventListener('click', onDocClickCapture, true);
			return;
		}
		if (hostEl.getAttribute('data-selected') !== 'true') return;
		// Editing affordances: keystrokes inside the edit row belong to its
		// inputs, not to the delete-on-Backspace selection behaviour.
		const target = event.target as HTMLElement | null;
		if (target?.closest('.embed-edit-row, .embed-edit, input, textarea')) return;
		if (event.key !== 'Backspace' && event.key !== 'Delete') return;
		event.preventDefault();
		clearEmbedSelection();
		editor.update(() => {
			const node = $getNodeByKey(key);
			node?.remove();
			// 根被删空时补一个可编辑段落,光标有落点
			const root = $getRoot();
			if (root.getChildrenSize() === 0) root.append($createParagraphNode());
		});
	};

	const onDocClickCapture = (event: MouseEvent): void => {
		if (!hostEl.isConnected) {
			document.removeEventListener('keydown', onDocKeydown, true);
			document.removeEventListener('click', onDocClickCapture, true);
			return;
		}
		if (hostEl.getAttribute('data-selected') !== 'true') return;
		if (event.target instanceof Node && hostEl.contains(event.target)) return;
		clearEmbedSelection();
	};

	document.addEventListener('keydown', onDocKeydown, true);
	document.addEventListener('click', onDocClickCapture, true);
}

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

	getTail(): string {
		return this.__tail;
	}

	/** In-place URL edit (editor-side "编辑" affordance). */
	setUrl(url: string): void {
		const writable = this.getWritable();
		writable.__url = url;
	}

	setProvider(provider: EmbedProviderId | 'generic'): void {
		const writable = this.getWritable();
		writable.__provider = provider;
	}

	setTitle(title: string): void {
		const writable = this.getWritable();
		writable.__title = title;
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
		const key = this.__key;
		mountDecorator(
			this,
			EmbedCard,
			container,
			{
				provider: this.__provider,
				url: this.__url,
				title: this.__title,
				editable: true,
				onUrlChange: (url: string, title: string) => {
					// 不触碰冻结实例:update 内按键取最新可写节点(官方模式)
					editor.update(() => {
						const node = $getNodeByKey(key);
						if ($isEmbedNode(node)) {
							node.setUrl(url);
							// provider derives from the URL: recompute so the card face,
							// the export and the render side agree after an in-place edit
							node.setProvider(resolveProviderId(url));
							node.setTitle(title);
						}
					});
				}
			},
			'⚠ 嵌入卡加载失败，按 Backspace 删除此块'
		);
		const hostEl = editor.getElementByKey(this.__key);
		if (hostEl) {
			hostEl.textContent = '';
			hostEl.appendChild(container);
			attachEmbedSelection(editor, hostEl, key);
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

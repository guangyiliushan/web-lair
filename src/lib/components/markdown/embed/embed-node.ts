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
import { m } from '$lib/paraglide/messages';

// ── Component-level selection (embed card inside the editor) ──
//
// Why not use Lexical NodeSelection: after a decorator click the DOM selection is empty,
// and Lexical's selection-rebuild path ($internalCreateRangeSelection) during a normal
// update overwrites a non-Range selection with the DOM selection (empty DOM selection → null,
// the useDOMSelection branch of `$internalCreateRangeSelection` in Lexical.dev.mjs)
// ——NodeSelection is inherently unstable in this scenario. The component-level flag (`data-selected`)
// does not enter Lexical's selection system, so behavior is controllable and testable; the arrow-key isKeyboardSelectable
// path is reserved for Lexical itself (it does not interfere with the click path).

let selectedHost: HTMLElement | null = null;

function clearEmbedSelection(): void {
	if (selectedHost) selectedHost.removeAttribute('data-selected');
	selectedHost = null;
}

/** Click = select (exclusive), Backspace/Delete = delete the node, clicking elsewhere = clear. */
function attachEmbedSelection(editor: LexicalEditor, hostEl: HTMLElement, key: NodeKey): void {
	hostEl.addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		// Let the edit-row controls through (preventDefault would also block input focus)
		if (target?.closest('.embed-edit-row, .embed-edit, input')) return;
		// Block the default in-editor navigation of links/façades inside the card
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
			// If the delete empties the root, append an editable paragraph so the cursor has a landing spot
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

	/** In-place URL edit (editor-side "Edit" affordance). */
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
					// Do not touch the frozen instance: look the node up by key inside update to get the latest writable node (the official pattern)
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
			m.editor_crash_embed()
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

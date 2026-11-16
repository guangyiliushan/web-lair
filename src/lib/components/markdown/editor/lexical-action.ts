import {
	createEditor,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	$isNodeSelection,
	$createParagraphNode,
	$createTextNode,
	SELECTION_CHANGE_COMMAND,
	CLEAR_EDITOR_COMMAND,
	COMMAND_PRIORITY_EDITOR,
	UNDO_COMMAND,
	REDO_COMMAND,
	type LexicalEditor,
	type LexicalCommand,
	type TextFormatType
} from 'lexical';
import { registerRichText } from '@lexical/rich-text';
import { $isDecoratorNode } from 'lexical';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import {
	registerMarkdownShortcuts,
	$convertFromMarkdownString,
	$convertToMarkdownString,
	type Transformer
} from '@lexical/markdown';
import { type HeadingTagType } from '@lexical/rich-text';
import {
	INSERT_UNORDERED_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	REMOVE_LIST_COMMAND,
	registerList,
	registerCheckList
} from '@lexical/list';
import { registerTablePlugin, registerTableSelectionObserver } from '@lexical/table';
import { INSERT_HORIZONTAL_RULE_COMMAND, $createHorizontalRuleNode } from '@lexical/extension';
import { $isAlertNode } from '$lib/components/markdown/alert/alert-node';
import { EDITOR_NODES } from '$lib/components/markdown/editor/editor-nodes';
import { EDITOR_THEME } from '$lib/components/markdown/editor/editor-shared';
import {
	registerEditorUploads,
	type EditorUploadStatus
} from '$lib/components/markdown/editor/upload-plugin';
import {
	EDITOR_TRANSFORMERS,
	$unescapeImportedText,
	normalizeMarkdownForImport
} from '$lib/components/markdown/editor/markdown-transformers';

export interface LexicalActionOptions {
	/** Initial markdown (used when there is no editorState) */
	initialMarkdown?: string;
	/** Whether the editor is editable */
	editable: boolean;
	/** Placeholder text */
	placeholder: string;
	/** Focus the editor on mount */
	autofocus: boolean;
	/** Custom transformers (override the default EDITOR_TRANSFORMERS) */
	transformers?: Transformer[];
	/** Content-change callback */
	onChange?: (detail: {
		editorStateJson: string;
		markdown: string;
		plainText: string;
		isEmpty: boolean;
	}) => void;
	/** Exposes the editor instance to a Svelte $state */
	onEditorReady?: (editor: LexicalEditor) => void;
	/** Paste/drop image uploads (3a3): status for the editor chrome. */
	onUploadStatus?: (status: EditorUploadStatus) => void;
}

/**
 * Svelte 5 action: binds an HTMLElement as a Lexical editor.
 *
 * @example
 * ```svelte
 * <div use:lexicalEditor={{ editable, placeholder, onChange, onEditorReady }}></div>
 * ```
 */
export function lexicalEditor(node: HTMLElement, initialOptions: LexicalActionOptions) {
	// Mutable reference container: closures always read `current`, update only swaps it
	const optionsRef = { current: initialOptions };

	// Do not set editable inside createEditor: a later setEditable(true) then becomes a
	// no-op, the contenteditable attribute never reaches the DOM and the editor cannot be typed into.
	const editor: LexicalEditor = createEditor({
		namespace: 'markdown-editor',
		nodes: EDITOR_NODES,
		theme: EDITOR_THEME,
		onError: (error: Error) => console.error('Lexical editor error:', error)
	});

	// Attach the DOM
	editor.setRootElement(node);

	// setEditable must run before registerRichText, otherwise RichTextPlugin initialises
	// without seeing editable=true and never sets the contenteditable attribute.
	editor.setEditable(optionsRef.current.editable);

	// Register the plugins and keep their cleanup functions
	const unregisterRichText = registerRichText(editor);

	// Safety net: make sure the contenteditable attribute reached the DOM.
	// Some Lexical versions do not update it from setEditable, so set it manually as a fallback.
	if (optionsRef.current.editable && !node.hasAttribute('contenteditable')) {
		node.setAttribute('contenteditable', 'true');
	}

	// Register markdown shortcut input (#, >, -, ```, 1., <tag> … auto-convert)
	const transformers = optionsRef.current.transformers ?? EDITOR_TRANSFORMERS;
	const unregisterMarkdownShortcuts = registerMarkdownShortcuts(editor, transformers);

	// Register history
	const unregisterHistory = registerHistory(editor, createEmptyHistoryState(), 300);

	// Register the list commands (unordered/ordered/checklist). Without them the toolbar
	// list buttons are no-ops and no list can be created. registerCheckList additionally
	// wires checklist ticking and click toggling.
	const unregisterList = registerList(editor);
	const unregisterCheckList = registerCheckList(editor);

	// Register the table command listeners (INSERT_TABLE_COMMAND and friends) and the
	// integrity transform, then the table selection observer separately (cell selection,
	// Tab navigation, arrow-key movement). Order matters: the selection observer must be
	// registered after registerTablePlugin (see its doc comment).
	const unregisterTablePlugin = registerTablePlugin(editor);
	const unregisterTableSelection = registerTableSelectionObserver(editor);

	// Register the horizontal-rule command. Lexical 0.46 moved this listener into
	// HorizontalRuleExtension, and the classic nodes mode (createEditor({nodes})) does not
	// run extension.register, so register it by hand or the rule button is a no-op.
	const unregisterHorizontalRule = editor.registerCommand(
		INSERT_HORIZONTAL_RULE_COMMAND,
		() => {
			const selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			selection.insertNodes([$createHorizontalRuleNode()]);
			return true;
		},
		COMMAND_PRIORITY_EDITOR
	);

	// Selection feedback for keyboard-selectable nodes (ImageNode and other DecoratorNodes):
	// the core adds no CSS class for NodeSelection, so mark data-selected for the styles.
	let markedSelectionEls: HTMLElement[] = [];
	const unregisterSelectionVisual = editor.registerUpdateListener(({ editorState }) => {
		const selectedKeys = new Set<string>();
		editorState.read(() => {
			const selection = $getSelection();
			if ($isNodeSelection(selection)) {
				for (const node of selection.getNodes()) selectedKeys.add(node.getKey());
			}
		});
		if (markedSelectionEls.length === 0 && selectedKeys.size === 0) return;
		for (const el of markedSelectionEls) el.removeAttribute('data-selected');
		markedSelectionEls = [];
		for (const key of selectedKeys) {
			const el = editor.getElementByKey(key);
			if (el) {
				el.setAttribute('data-selected', 'true');
				markedSelectionEls.push(el);
			}
		}
	});

	// Paste/drop image uploads (3a3): @lexical/rich-text routes local
	// pasted/dropped files into the DRAG_DROP_PASTE command; the plugin
	// consumes them (local images only, up to three in flight, each result
	// inserted as it lands).
	const unregisterUploads = registerEditorUploads(editor, (status) =>
		optionsRef.current.onUploadStatus?.(status)
	);

	// Load the initial content
	editor.update(
		() => {
			const root = $getRoot();
			const md = optionsRef.current.initialMarkdown;
			if (md) {
				try {
					$convertFromMarkdownString(normalizeMarkdownForImport(md), transformers);
					$unescapeImportedText();
				} catch {
					root.clear();
					const p = $createParagraphNode();
					p.append($createTextNode(md));
					root.append(p);
				}
			} else {
				root.clear();
				root.append($createParagraphNode());
			}
			// A block decorator as the last root child leaves the caret nowhere to
			// land (its host is contentEditable=false, and nothing follows it):
			// guarantee an editable paragraph at the end of the document.
			const lastChild = root.getLastChild();
			if (lastChild && $isDecoratorNode(lastChild) && !lastChild.isInline()) {
				root.append($createParagraphNode());
			}
		},
		{ discrete: true }
	);

	// Register the update listener — closures read the latest options via optionsRef.current
	const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
		let markdown = '';
		let plainText = '';
		let isEmpty = false;
		editorState.read(() => {
			markdown = $convertToMarkdownString(transformers);
			plainText = $getRoot().getTextContent();
			const children = $getRoot().getChildren();
			isEmpty =
				children.length === 1 &&
				children[0].getType() === 'paragraph' &&
				children[0].getTextContent().trim() === '';
		});
		// Always read the latest onChange callback
		optionsRef.current.onChange?.({
			editorStateJson: JSON.stringify(editorState.toJSON()),
			markdown,
			plainText,
			isEmpty
		});
	});

	// Hand the editor instance out
	optionsRef.current.onEditorReady?.(editor);

	// Autofocus
	if (optionsRef.current.autofocus) {
		setTimeout(() => node.focus(), 0);
	}

	// Focus event proxy
	const focusListener = () => node.dispatchEvent(new CustomEvent('lexfocus'));
	const blurListener = () => node.dispatchEvent(new CustomEvent('lexblur'));
	node.addEventListener('focus', focusListener, true);
	node.addEventListener('blur', blurListener, true);

	return {
		update(newOptions: LexicalActionOptions) {
			// Swap the reference container — closures pick the new value up automatically
			optionsRef.current = newOptions;
			// Sync the editable state (without recreating the editor)
			if (editor.isEditable() !== newOptions.editable) {
				editor.setEditable(newOptions.editable);
				// Sync the contenteditable DOM attribute
				if (newOptions.editable) {
					node.setAttribute('contenteditable', 'true');
				} else {
					node.removeAttribute('contenteditable');
				}
			}
		},
		destroy() {
			unregisterUpdate();
			unregisterRichText();
			unregisterMarkdownShortcuts();
			unregisterHistory();
			unregisterList();
			unregisterCheckList();
			unregisterTableSelection();
			unregisterTablePlugin();
			unregisterHorizontalRule();
			unregisterSelectionVisual();
			unregisterUploads();
			markedSelectionEls = [];
			node.removeEventListener('focus', focusListener, true);
			node.removeEventListener('blur', blurListener, true);
			editor.setRootElement(null);
		}
	};
}

// ── Re-exports for the toolbar ──
export {
	SELECTION_CHANGE_COMMAND,
	CLEAR_EDITOR_COMMAND,
	UNDO_COMMAND,
	REDO_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	REMOVE_LIST_COMMAND,
	INSERT_HORIZONTAL_RULE_COMMAND
};
export type { LexicalEditor, TextFormatType, LexicalCommand, HeadingTagType };

// ── Re-export the $-prefixed helpers (for nested-editor .svelte files) ──
// Svelte 5 forbids importing $-prefixed functions inside .svelte files, so they are
// re-exported under aliases that nested editor components can safely reference
export {
	$getRoot as getLexicalRoot,
	$createParagraphNode as createLexicalParagraph,
	$getSelection as getLexicalSelection,
	$isRangeSelection as isLexicalRangeSelection,
	$getNodeByKey as getLexicalNodeByKey,
	$getNearestNodeFromDOMNode as getLexicalNearestNodeFromDOM
} from 'lexical';

// $-prefixed helpers from alert-node.ts need aliases here as well
export { $isAlertNode as isAlertNode };

// Full editor transformer list (Tag/Alert included) for MarkdownEditor and friends
export { EDITOR_TRANSFORMERS };

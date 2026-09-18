import {
	createEditor,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	$isNodeSelection,
	$createParagraphNode,
	$createTextNode,
	FORMAT_ELEMENT_COMMAND,
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
import { EDITOR_TRANSFORMERS } from '$lib/components/markdown/editor/markdown-transformers';

export interface LexicalActionOptions {
	/** 初始 markdown（当无 editorState 时使用） */
	initialMarkdown?: string;
	/** 是否可编辑 */
	editable: boolean;
	/** 占位文本 */
	placeholder: string;
	/** 自动聚焦 */
	autofocus: boolean;
	/** 自定义 transformer（覆盖默认 EDITOR_TRANSFORMERS） */
	transformers?: Transformer[];
	/** 内容变化回调 */
	onChange?: (detail: {
		editorStateJson: string;
		markdown: string;
		plainText: string;
		isEmpty: boolean;
	}) => void;
	/** 将 editor 实例抛出给 Svelte $state */
	onEditorReady?: (editor: LexicalEditor) => void;
}

/**
 * Svelte 5 Action：将 HTMLElement 绑定为 Lexical 编辑器。
 *
 * @example
 * ```svelte
 * <div use:lexicalEditor={{ editable, placeholder, onChange, onEditorReady }}></div>
 * ```
 */
export function lexicalEditor(node: HTMLElement, initialOptions: LexicalActionOptions) {
	// 可变引用容器：闭包始终读取 current，update 时只更新 current
	const optionsRef = { current: initialOptions };

	// 注意：不要在 createEditor 中设置 editable，否则后续 setEditable(true) 会是 no-op，
	// 导致 contenteditable 属性不会被写入 DOM，编辑器无法输入。
	const editor: LexicalEditor = createEditor({
		namespace: 'markdown-editor',
		nodes: EDITOR_NODES,
		theme: EDITOR_THEME,
		onError: (error: Error) => console.error('Lexical editor error:', error)
	});

	// 挂载 DOM
	editor.setRootElement(node);

	// 必须在 registerRichText 之前调用 setEditable，否则 RichTextPlugin
	// 初始化时看不到 editable=true，不会设置 contenteditable 属性。
	editor.setEditable(optionsRef.current.editable);

	// 注册插件并保存清理函数
	const unregisterRichText = registerRichText(editor);

	// 安全网：确保 contenteditable 属性已写入 DOM。
	// 某些 Lexical 版本中 setEditable 不会触发 DOM 属性更新，
	// 因此手动设置作为后备方案。
	if (optionsRef.current.editable && !node.hasAttribute('contenteditable')) {
		node.setAttribute('contenteditable', 'true');
	}

	// 注册 Markdown 快捷输入（# / > / - / ``` / 1. / <tag> 等自动转换）
	const transformers = optionsRef.current.transformers ?? EDITOR_TRANSFORMERS;
	const unregisterMarkdownShortcuts = registerMarkdownShortcuts(editor, transformers);

	// 注册历史
	const unregisterHistory = registerHistory(editor, createEmptyHistoryState(), 300);

	// 注册列表命令（无序/有序/待办）。缺失时工具栏列表按钮是 no-op，
	// 列表无法创建。registerCheckList 额外注册待办勾选/点击切换。
	const unregisterList = registerList(editor);
	const unregisterCheckList = registerCheckList(editor);

	// 注册表格命令监听（INSERT_TABLE_COMMAND 等）与完整性 transform，
	// 再单独注册表格选区观察器（单元格选区/Tab 导航/方向键移动）。
	// 顺序要求：selection observer 必须在 registerTablePlugin 之后（见其文档注释）。
	const unregisterTablePlugin = registerTablePlugin(editor);
	const unregisterTableSelection = registerTableSelectionObserver(editor);

	// 注册水平分割线命令。Lexical 0.46 将该命令监听器移入 HorizontalRuleExtension，
	// 经典 nodes 模式（createEditor({nodes})）不会自动执行 extension.register，
	// 需手动注册，否则分割线按钮是 no-op。
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

	// 键盘可选中节点（ImageNode 等 DecoratorNode）的选中态视觉反馈：
	// 核心不为 NodeSelection 加 CSS 类，这里标记 data-selected 供样式呈现。
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

	// 加载初始内容
	editor.update(
		() => {
			const root = $getRoot();
			const md = optionsRef.current.initialMarkdown;
			if (md) {
				try {
					$convertFromMarkdownString(md, transformers);
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
		},
		{ discrete: true }
	);

	// 注册更新监听——闭包通过 optionsRef.current 读取最新 options
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
		// 始终读取最新的 onChange 回调
		optionsRef.current.onChange?.({
			editorStateJson: JSON.stringify(editorState.toJSON()),
			markdown,
			plainText,
			isEmpty
		});
	});

	// 抛出 editor 实例
	optionsRef.current.onEditorReady?.(editor);

	// 自动聚焦
	if (optionsRef.current.autofocus) {
		setTimeout(() => node.focus(), 0);
	}

	// 焦点事件代理
	const focusListener = () => node.dispatchEvent(new CustomEvent('lexfocus'));
	const blurListener = () => node.dispatchEvent(new CustomEvent('lexblur'));
	node.addEventListener('focus', focusListener, true);
	node.addEventListener('blur', blurListener, true);

	return {
		update(newOptions: LexicalActionOptions) {
			// 更新引用容器——闭包自动读取最新值
			optionsRef.current = newOptions;
			// 同步 editable 状态（不重建 editor）
			if (editor.isEditable() !== newOptions.editable) {
				editor.setEditable(newOptions.editable);
				// 同步 contenteditable DOM 属性
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
			markedSelectionEls = [];
			node.removeEventListener('focus', focusListener, true);
			node.removeEventListener('blur', blurListener, true);
			editor.setRootElement(null);
		}
	};
}

// ── 导出供 toolbar 使用 ──
export {
	FORMAT_ELEMENT_COMMAND,
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

// ── 重导出 $ 前缀函数（供嵌套编辑器 .svelte 文件使用）──
// Svelte 5 不允许 .svelte 文件中直接 import $ 前缀的函数
// 通过别名重导出，使嵌套编辑器组件可以安全引用
export {
	$getRoot as getLexicalRoot,
	$createParagraphNode as createLexicalParagraph,
	$getSelection as getLexicalSelection,
	$isRangeSelection as isLexicalRangeSelection,
	$getNodeByKey as getLexicalNodeByKey,
	$getNearestNodeFromDOMNode as getLexicalNearestNodeFromDOM
} from 'lexical';

// 来自 alert-node.ts 的 $ 前缀函数也需要别名
export { $isAlertNode as isAlertNode };

// 编辑器完整 transformer 列表（含 Tag/Alert），供 MarkdownEditor 等使用
export { EDITOR_TRANSFORMERS };

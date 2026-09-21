<script lang="ts">
	import { cn } from '$lib/utils';
	import { mount, unmount } from 'svelte';
	import type { LexicalEditor } from 'lexical';
	import { lexicalEditor } from '$lib/components/markdown/editor/lexical-action';
	import type {
		MarkdownEditorProps,
		MarkdownEditorChangeDetail
	} from '$lib/components/markdown/editor/markdown-config';
	import EditorToolbar from '$lib/components/markdown/toolbar/EditorToolbar.svelte';
	import FloatingFormatToolbar from '$lib/components/markdown/toolbar/FloatingFormatToolbar.svelte';
	import BlockHandleToolbar from '$lib/components/markdown/toolbar/BlockHandleToolbar.svelte';
	import CodeModeToggle from '$lib/components/markdown/toolbar/CodeModeToggle.svelte';
	import TableCellMenu from '$lib/components/markdown/toolbar/TableCellMenu.svelte';

	// Lexical 编辑器全局样式（由 PostCSS 处理 @apply / Tailwind 指令）
	import '$lib/components/markdown/editor/lexical-editor.css';

	import { $convertToMarkdownString as convertToMarkdown } from '@lexical/markdown';
	import { EDITOR_TRANSFORMERS } from '$lib/components/markdown/editor/markdown-transformers';
	import { getMathNodeInfo, updateMathNode } from '$lib/components/markdown/editor/lexical-helpers';
	import MathEditDialog from '$lib/components/markdown/toolbar/MathEditDialog.svelte';
	import {
		MATH_EDIT_EVENT,
		type MathEditEventDetail
	} from '$lib/components/markdown/math/math-render';

	let {
		value,
		initialMarkdown,
		editable = true,
		placeholder = '开始输入...',
		theme = 'default',
		autofocus = false,
		showToolbar = true,
		stickyToolbar = false,
		borderless = false,
		class: className,
		onChange,
		onBlur,
		onFocus
	}: MarkdownEditorProps & {
		onChange?: (detail: MarkdownEditorChangeDetail) => void;
		onBlur?: () => void;
		onFocus?: () => void;
		stickyToolbar?: boolean;
		borderless?: boolean;
	} = $props();

	let editor: LexicalEditor | null = $state(null);
	let codeMode = $state(false);
	let codeModeText = $state('');
	/** Code-mode edits handed to the rebuilt editor after leaving code mode. */
	let pendingMarkdown = $state<string | null>(null);

	// ── 代码模式行号 gutter ──
	const lineNumbers = $derived(
		Array.from({ length: codeModeText.split('\n').length }, (_, i) => i + 1)
	);
	// Auto-grow with content so the page is the only scroll container
	// (leading-6 = 24px per line + py-3 = 24px + 2px slack, floor at 192px).
	const codeHeight = $derived(Math.max(192, lineNumbers.length * 24 + 26));

	function handleEditorReady(e: LexicalEditor) {
		editor = e;
		pendingMarkdown = null;
	}

	// ── Block Handle Toolbar: portal to document.body ──
	let blockHandleApp: ReturnType<typeof mount> | null = null;

	$effect(() => {
		// 当 editor 就绪且 editable 时挂载 block handle
		if (editor && editable) {
			blockHandleApp = mount(BlockHandleToolbar, {
				target: document.body,
				props: { editor: editor as LexicalEditor }
			});
		}

		return () => {
			if (blockHandleApp) {
				unmount(blockHandleApp);
				blockHandleApp = null;
			}
		};
	});

	function handleChange(detail: {
		editorStateJson: string;
		markdown: string;
		plainText: string;
		isEmpty: boolean;
	}) {
		codeModeText = detail.markdown;
		onChange?.(detail);
	}

	// 代码模式 → 切换回富文本时，将编辑后的 markdown 同步回 Lexical
	function toggleCodeMode() {
		if (!codeMode) {
			// 进入代码模式：从 Lexical 导出 markdown（保留标题/列表/Tag/Alert 等格式）
			editor?.getEditorState().read(() => {
				codeModeText = convertToMarkdown(EDITOR_TRANSFORMERS);
			});
		} else {
			// exit: the codeMode branch rebuilds the rich editor; the old instance's
			// update is a no-op. Hand the source to the rebuild path instead.
			pendingMarkdown = codeModeText;
		}
		codeMode = !codeMode;
	}

	// 代码模式下手动输入时同步 onChange
	function onCodeModeInput(e: Event) {
		const target = e.currentTarget as HTMLTextAreaElement;
		codeModeText = target.value;
		onChange?.({
			editorStateJson: '',
			markdown: target.value,
			plainText: target.value,
			isEmpty: !target.value.trim()
		});
	}

	// ── 数学编辑（批 B）：点击公式打开编辑对话框 ──
	let mathDialogOpen = $state(false);
	let mathNodeKey = $state<string | null>(null);
	let mathLatex = $state('');
	let mathDisplayMode = $state(false);

	$effect(() => {
		const rootEl = editor?.getRootElement();
		if (!rootEl) return;
		const onMathEdit = (event: Event) => {
			const detail = (event as CustomEvent<MathEditEventDetail>).detail;
			if (!detail?.key || !editor) return;
			const info = getMathNodeInfo(editor, detail.key);
			if (!info) return;
			mathNodeKey = detail.key;
			mathLatex = info.latex;
			mathDisplayMode = info.displayMode;
			mathDialogOpen = true;
		};
		rootEl.addEventListener(MATH_EDIT_EVENT, onMathEdit);
		return () => rootEl.removeEventListener(MATH_EDIT_EVENT, onMathEdit);
	});

	function handleMathSave(latex: string) {
		if (editor && mathNodeKey) updateMathNode(editor, mathNodeKey, latex);
	}
</script>

<div class={cn('flex flex-col', className)}>
	<!-- Toolbar -->
	{#if showToolbar && editable}
		<div
			class={cn(
				'flex min-w-0 items-center gap-0.5',
				stickyToolbar &&
					'sticky top-14 z-10 border-b border-border bg-background/80 backdrop-blur-sm'
			)}
		>
			<EditorToolbar {editor} class="min-w-0 flex-1" />
			<CodeModeToggle {codeMode} onToggle={toggleCodeMode} />
		</div>

		<!-- 浮动格式工具栏：选中文本时出现 -->
		<FloatingFormatToolbar {editor} />

		<!-- 浮动表格菜单：光标进入表格单元格时出现 -->
		<TableCellMenu {editor} />
	{/if}

	<!-- Editor area -->
	<div class="min-h-0 flex-1">
		{#if codeMode}
			<!-- 代码模式：纯文本编辑（无框视觉 + 行号 gutter，随内容自动增高，由页面统一滚动） -->
			<div
				class={cn(
					'flex min-h-48 w-full overflow-hidden',
					!borderless && 'rounded-lg border border-border bg-background'
				)}
				style="height: {codeHeight}px"
			>
				<div
					aria-hidden="true"
					class="w-10 shrink-0 overflow-hidden py-3 pr-2 text-right font-mono text-sm leading-6 text-muted-foreground/50 select-none"
				>
					{#each lineNumbers as n (n)}
						<div>{n}</div>
					{/each}
				</div>
				<textarea
					bind:value={codeModeText}
					oninput={onCodeModeInput}
					{placeholder}
					spellcheck="false"
					wrap="off"
					class="min-h-48 w-full flex-1 resize-none overflow-y-hidden bg-transparent px-3 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/50"
				></textarea>
			</div>
		{:else}
			<!-- 富文本模式：Lexical 编辑器 -->
			<div
				use:lexicalEditor={{
					initialMarkdown: pendingMarkdown ?? value ?? initialMarkdown,
					editable,
					placeholder,
					autofocus,
					onChange: handleChange,
					onEditorReady: handleEditorReady
				}}
				role="textbox"
				aria-multiline="true"
				aria-label={placeholder}
				class={cn(
					'h-full min-h-48 w-full px-4 py-3 text-base leading-7 outline-none',
					'text-foreground',
					!borderless && 'rounded-lg border border-border bg-background',
					theme === 'compact' && 'min-h-32 px-3 py-2 text-sm',
					!editable && 'cursor-default opacity-70'
				)}
				data-placeholder={placeholder}
				onfocus={() => onFocus?.()}
				onblur={() => onBlur?.()}
			></div>
		{/if}
	</div>

	<MathEditDialog
		bind:open={mathDialogOpen}
		initialLatex={mathLatex}
		displayMode={mathDisplayMode}
		onSave={handleMathSave}
	/>
</div>

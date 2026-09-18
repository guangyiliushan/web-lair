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

	import {
		$getRoot as getLexicalRoot,
		$createParagraphNode as createLexicalParagraph,
		$createTextNode as createLexicalText
	} from 'lexical';
	import {
		$convertToMarkdownString as convertToMarkdown,
		$convertFromMarkdownString as convertFromMarkdown
	} from '@lexical/markdown';
	import { EDITOR_TRANSFORMERS } from '$lib/components/markdown/editor/markdown-transformers';

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

	// ── 代码模式行号 gutter ──
	const lineNumbers = $derived(
		Array.from({ length: codeModeText.split('\n').length }, (_, i) => i + 1)
	);
	// Auto-grow with content so the page is the only scroll container
	// (leading-6 = 24px per line + py-3 = 24px + 2px slack, floor at 192px).
	const codeHeight = $derived(Math.max(192, lineNumbers.length * 24 + 26));

	function handleEditorReady(e: LexicalEditor) {
		editor = e;
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
			// 退出代码模式：将编辑后的 markdown 解析回 Lexical 节点树
			editor?.update(
				() => {
					const root = getLexicalRoot();
					root.clear();
					try {
						convertFromMarkdown(codeModeText, EDITOR_TRANSFORMERS);
					} catch {
						// 解析失败时作为纯文本回退
						root.clear();
						const p = createLexicalParagraph();
						p.append(createLexicalText(codeModeText));
						root.append(p);
					}
				},
				{ discrete: true }
			);
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
					initialMarkdown: value ?? initialMarkdown,
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
</div>

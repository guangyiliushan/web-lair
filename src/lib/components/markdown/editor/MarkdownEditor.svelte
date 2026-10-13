<script lang="ts">
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
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
	import LinkHoverEditor from '$lib/components/markdown/toolbar/LinkHoverEditor.svelte';
	import { uploadErrorCopy } from '$lib/components/markdown/editor/upload-feedback';
	import type { EditorUploadStatus } from '$lib/components/markdown/editor/upload-plugin';

	// Global styles for the Lexical editor (PostCSS processes the @apply / Tailwind directives)
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
		placeholder = m.editor_placeholder_default(),
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
	/** Paste/drop upload status from the editor pipeline (3a3). */
	let uploadStatus = $state<EditorUploadStatus>({ uploading: 0, lastErrorCode: null });

	// ── Code-mode line-number gutter ──
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
		// Mount the block handle when the editor is ready and editable
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

	// Code mode → rich text: sync the edited markdown back into Lexical
	function toggleCodeMode() {
		if (!codeMode) {
			// Entering code mode: export the markdown from Lexical (preserves heading/list/Tag/Alert formatting)
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

	// Sync onChange while typing manually in code mode
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

	// ── Math editing (batch B): clicking a formula opens the edit dialog ──
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

		<!-- Floating format toolbar: appears when text is selected -->
		<FloatingFormatToolbar {editor} />

		<!-- Floating table menu: appears when the cursor enters a table cell -->
		<TableCellMenu {editor} />

		<!-- In-place link editor overlay: appears when the cursor lands inside a link -->
		<LinkHoverEditor {editor} />
	{/if}

	<!-- Editor area -->
	<div class="min-h-0 flex-1">
		{#if codeMode}
			<!-- Code mode: plain-text editing (borderless look + line-number gutter, auto-grows with content, the page is the only scroll container) -->
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
			<!-- Rich-text mode: the Lexical editor -->
			<div
				use:lexicalEditor={{
					initialMarkdown: pendingMarkdown ?? value ?? initialMarkdown,
					editable,
					placeholder,
					autofocus,
					onChange: handleChange,
					onEditorReady: handleEditorReady,
					onUploadStatus: (status) => (uploadStatus = status)
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

	{#if uploadStatus.uploading > 0 || uploadStatus.lastErrorCode !== null}
		<div role="status" class="px-1 pt-2 text-xs">
			{#if uploadStatus.uploading > 0}
				<span class="text-muted-foreground">{m.image_uploading()}</span>
			{:else}
				<span class="text-destructive">{uploadErrorCopy(uploadStatus.lastErrorCode)}</span>
			{/if}
		</div>
	{/if}

	<MathEditDialog
		bind:open={mathDialogOpen}
		initialLatex={mathLatex}
		displayMode={mathDisplayMode}
		onSave={handleMathSave}
	/>
</div>

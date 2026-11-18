<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import type { LexicalEditor, TextFormatType, AnyLexicalCommand } from 'lexical';
	import { UNDO_COMMAND, REDO_COMMAND } from '$lib/components/markdown/editor/lexical-action';
	import {
		toggleHeading,
		toggleBulletList,
		toggleOrderedList,
		toggleBlockquote,
		insertHorizontalRule,
		insertImage,
		insertTable,
		insertCodeBlock,
		insertTag,
		insertAlert,
		insertCheckList,
		insertMath,
		insertFootnoteRef,
		insertFootnoteInline,
		insertMention,
		insertDetails,
		insertEmbed,
		insertMermaid,
		insertTabs,
		insertGrid,
		applyParagraph,
		emptyToolbarState,
		formatTextWithFocus,
		toggleSpoiler,
		readToolbarState,
		type ToolbarState
	} from '$lib/components/markdown/editor/lexical-helpers';
	import { openLinkEditor } from './link-editor-channel';
	import EditorDebugDialog from './EditorDebugDialog.svelte';
	import ImageInsertDialog from './ImageInsertDialog.svelte';
	import CodeBlockInsertDialog from './CodeBlockInsertDialog.svelte';
	import ValuePromptDialog from './ValuePromptDialog.svelte';

	// ── Icons ──
	import IconH1 from '@tabler/icons-svelte-runes/icons/h-1';
	import IconH2 from '@tabler/icons-svelte-runes/icons/h-2';
	import IconH3 from '@tabler/icons-svelte-runes/icons/h-3';
	import IconArrowBackUp from '@tabler/icons-svelte-runes/icons/arrow-back-up';
	import IconArrowForwardUp from '@tabler/icons-svelte-runes/icons/arrow-forward-up';
	import IconBold from '@tabler/icons-svelte-runes/icons/bold';
	import IconItalic from '@tabler/icons-svelte-runes/icons/italic';
	import IconUnderline from '@tabler/icons-svelte-runes/icons/underline';
	import IconStrikethrough from '@tabler/icons-svelte-runes/icons/strikethrough';
	import IconCode from '@tabler/icons-svelte-runes/icons/code';
	import IconCodeDots from '@tabler/icons-svelte-runes/icons/code-dots';
	import IconHighlight from '@tabler/icons-svelte-runes/icons/highlight';
	import IconEyeOff from '@tabler/icons-svelte-runes/icons/eye-off';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconList from '@tabler/icons-svelte-runes/icons/list';
	import IconListNumbers from '@tabler/icons-svelte-runes/icons/list-numbers';
	import IconListCheck from '@tabler/icons-svelte-runes/icons/list-check';
	import IconBlockquote from '@tabler/icons-svelte-runes/icons/blockquote';
	import IconSeparator from '@tabler/icons-svelte-runes/icons/separator';
	import IconTable from '@tabler/icons-svelte-runes/icons/table';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconAlertOctagon from '@tabler/icons-svelte-runes/icons/alert-octagon';
	import {
		ALERT_LABELS,
		ALERT_TYPES,
		type AlertType
	} from '$lib/components/markdown/alert/alert-types';
	import IconMath from '@tabler/icons-svelte-runes/icons/math';
	import IconBug from '@tabler/icons-svelte-runes/icons/bug';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconNote from '@tabler/icons-svelte-runes/icons/note';
	import IconAt from '@tabler/icons-svelte-runes/icons/at';
	import IconListDetails from '@tabler/icons-svelte-runes/icons/list-details';
	import IconCards from '@tabler/icons-svelte-runes/icons/cards';
	import IconChartDots from '@tabler/icons-svelte-runes/icons/chart-dots';
	import IconLayoutList from '@tabler/icons-svelte-runes/icons/layout-list';
	import IconLayoutGrid from '@tabler/icons-svelte-runes/icons/layout-grid';

	// ── Types ──
	type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote';

	interface BlockOption {
		type: BlockType;
		label: string;
		icon: typeof IconArticle;
	}

	/** Breakpoint level: 0=mobile, 1=sm(~420px), 2=md(~650px), 3=lg(~900px), 4=xl(~950px) */
	type BpLevel = 0 | 1 | 2 | 3 | 4;

	const BLOCK_OPTIONS: BlockOption[] = [
		{ type: 'paragraph', label: m.editor_block_paragraph(), icon: IconArticle },
		{ type: 'h1', label: m.editor_block_h1(), icon: IconH1 },
		{ type: 'h2', label: m.editor_block_h2(), icon: IconH2 },
		{ type: 'h3', label: m.editor_block_h3(), icon: IconH3 }
	];

	// ── Props ──
	type Props = {
		editor: LexicalEditor | null;
		class?: string;
		/** Code (source) mode is on - the editor shows markdown instead of WYSIWYG. */
		codeMode?: boolean;
		onToggleCodeMode?: () => void;
	};

	let { editor, class: className, codeMode = false, onToggleCodeMode }: Props = $props();

	// ── Breakpoint thresholds based on the toolbar wrapper's actual width (ensures zero internal
	// overflow) ──
	const BP_THRESHOLDS = { xl: 950, lg: 900, md: 650, sm: 420 } as const;

	// SSR fallback: use the viewport width for the initial estimate to avoid hydration flicker
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	// ResizeObserver measures the actual rendered width of the toolbar's own root element
	let wrapperEl = $state<HTMLElement | null>(null);
	let wrapperWidth = $state(0);

	$effect(() => {
		if (!wrapperEl) return;
		const ro = new ResizeObserver(([entry]) => {
			if (entry) wrapperWidth = entry.contentRect.width;
		});
		ro.observe(wrapperEl);
		return () => ro.disconnect();
	});

	// wrapperWidth > 0 means the first real measurement is done; until then use the viewportWidth
	// fallback
	const effectiveWidth = $derived(wrapperWidth > 0 ? wrapperWidth : viewportWidth);

	let bp: BpLevel = $derived.by(() => {
		const w = effectiveWidth;
		if (w >= BP_THRESHOLDS.xl) return 4;
		if (w >= BP_THRESHOLDS.lg) return 3;
		if (w >= BP_THRESHOLDS.md) return 2;
		if (w >= BP_THRESHOLDS.sm) return 1;
		return 0;
	});

	// ── Toolbar state ──
	let toolbarState = $state<ToolbarState>(emptyToolbarState());

	let debugOpen = $state(false);
	let debugJson = $state('');

	let imageDialogOpen = $state(false);
	let codeDialogOpen = $state(false);

	/** Shared one-value prompt (mention / inline footnote / card URL). */
	let promptOpen = $state(false);
	let promptTitle = $state('');
	let promptLabel = $state('');
	let promptHint = $state<string | undefined>(undefined);
	let promptPlaceholder = $state<string | undefined>(undefined);
	let promptSubmit = $state<(value: string) => void>(() => {});

	function openPrompt(config: {
		title: string;
		label: string;
		hint?: string;
		placeholder?: string;
		onSubmit: (value: string) => void;
	}) {
		promptTitle = config.title;
		promptLabel = config.label;
		promptHint = config.hint;
		promptPlaceholder = config.placeholder;
		promptSubmit = config.onSubmit;
		promptOpen = true;
	}

	$effect(() => {
		if (!editor) return;
		const unregister = editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				toolbarState = readToolbarState();
			});
		});
		return unregister;
	});

	// ── Common utility functions ──
	function dispatchCmd(cmd: AnyLexicalCommand, payload?: unknown) {
		editor?.dispatchCommand(cmd, payload);
	}
	function formatText(format: TextFormatType) {
		formatTextWithFocus(editor, format);
	}
	function preventSelectionLoss(e: MouseEvent) {
		e.preventDefault();
	}

	function applyBlockType(type: BlockType) {
		if (!editor) return;
		switch (type) {
			case 'paragraph':
				applyParagraph(editor);
				break;
			case 'h1':
				toggleHeading(editor, 'h1');
				break;
			case 'h2':
				toggleHeading(editor, 'h2');
				break;
			case 'h3':
				toggleHeading(editor, 'h3');
				break;
			case 'bullet':
				toggleBulletList(editor);
				break;
			case 'number':
				toggleOrderedList(editor);
				break;
			case 'check':
				insertCheckList(editor);
				break;
			case 'quote':
				toggleBlockquote(editor);
				break;
		}
	}

	function openDebug() {
		if (!editor) return;
		debugJson = JSON.stringify(editor.getEditorState().toJSON(), null, 2);
		debugOpen = true;
	}

	function handleInsertLink() {
		if (!editor) return;
		// The in-place editing overlay takes over (window.prompt is unavailable in embedded
		// browsers/automation environments,
		// and it interrupts the editing context); selection semantics are handled inside
		// LinkHoverEditor.
		openLinkEditor();
	}

	function handleInsertImage() {
		if (!editor) return;
		imageDialogOpen = true;
	}

	function handleInsertCodeBlock() {
		if (!editor) return;
		codeDialogOpen = true;
	}

	function handleCodeBlockInsert(language: string) {
		if (!editor) return;
		insertCodeBlock(editor, language);
	}

	function handleImageInsert(url: string, alt: string, tailAttrs: string) {
		if (!editor) return;
		insertImage(editor, url, alt, tailAttrs);
	}

	function handleInsertTable() {
		if (!editor) return;
		insertTable(editor);
	}

	function handleInsertMath() {
		if (!editor) return;
		openPrompt({
			title: m.editor_insert_math(),
			label: m.editor_insert_math(),
			placeholder: 'E=mc^2',
			onSubmit: (value) => insertMath(editor!, value)
		});
	}

	function handleInsertFootnote() {
		if (!editor) return;
		insertFootnoteRef(editor);
	}

	function handleInsertFootnoteInline() {
		if (!editor) return;
		openPrompt({
			title: m.editor_insert_footnote_inline(),
			label: m.editor_prompt_footnote_label(),
			onSubmit: (value) => insertFootnoteInline(editor!, value)
		});
	}

	function handleInsertMention() {
		if (!editor) return;
		openPrompt({
			title: m.editor_insert_mention(),
			label: m.editor_prompt_mention_label(),
			hint: m.editor_prompt_mention_hint(),
			placeholder: '@gh:octocat',
			onSubmit: (value) => insertMention(editor!, value)
		});
	}

	function handleInsertEmbed() {
		if (!editor) return;
		openPrompt({
			title: m.editor_insert_embed(),
			label: m.editor_prompt_embed_label(),
			hint: m.editor_prompt_embed_hint(),
			placeholder: 'https://github.com/org/repo',
			onSubmit: (value) => insertEmbed(editor!, value)
		});
	}

	// The currently active block option
	let activeBlock = $derived(
		BLOCK_OPTIONS.find((o) => o.type === toolbarState.blockType) ?? BLOCK_OPTIONS[0]
	);

	// ── Overflow menu definition ──
	interface OverflowItemDef {
		id: string;
		label: string;
		icon: typeof IconArticle;
		action: () => void;
		/**
		 * Lowest breakpoint at which the toolbar shows this item; enters the overflow collector when
		 * bp < minBp
		 */
		minBp: BpLevel;
		disabled?: () => boolean;
	}

	const ALERT_ICONS: Record<AlertType, typeof IconArticle> = {
		note: IconInfoCircle,
		tip: IconBulb,
		important: IconAlertCircle,
		warning: IconAlertTriangle,
		caution: IconAlertOctagon
	};

	/**
	 * Every flat control in one ordered list: the row renders it while `bp` is
	 * at or above `minBp`, and the single `⋯` collector takes the rest. One
	 * collector, no per-group menus - that is what keeps the row usable across
	 * viewports without an internal scrollbar.
	 */
	const OVERFLOW_ITEMS: OverflowItemDef[] = [
		{
			id: 'underline',
			label: m.toolbar_underline(),
			icon: IconUnderline,
			action: () => formatText('underline'),
			minBp: 2
		},
		{
			id: 'strikethrough',
			label: m.toolbar_strikethrough(),
			icon: IconStrikethrough,
			action: () => formatText('strikethrough'),
			minBp: 2
		},
		{
			id: 'highlight',
			label: m.toolbar_highlight(),
			icon: IconHighlight,
			action: () => formatText('highlight'),
			minBp: 3
		},
		{
			id: 'spoiler',
			label: m.toolbar_spoiler(),
			icon: IconEyeOff,
			action: () => toggleSpoiler(editor!),
			minBp: 3
		},
		{
			id: 'inlineCode',
			label: m.toolbar_inline_code(),
			icon: IconCode,
			action: () => formatText('code'),
			minBp: 1
		},
		{
			id: 'undo',
			label: m.toolbar_undo(),
			icon: IconArrowBackUp,
			action: () => dispatchCmd(UNDO_COMMAND),
			minBp: 1
		},
		{
			id: 'redo',
			label: m.toolbar_redo(),
			icon: IconArrowForwardUp,
			action: () => dispatchCmd(REDO_COMMAND),
			minBp: 1
		},
		{
			id: 'bulletList',
			label: m.toolbar_ul(),
			icon: IconList,
			action: () => toggleBulletList(editor!),
			minBp: 1
		},
		{
			id: 'orderedList',
			label: m.toolbar_ol(),
			icon: IconListNumbers,
			action: () => toggleOrderedList(editor!),
			minBp: 1
		},
		{
			id: 'checkList',
			label: m.toolbar_todo(),
			icon: IconListCheck,
			action: () => applyBlockType('check'),
			minBp: 1
		},
		{
			id: 'quote',
			label: m.toolbar_quote(),
			icon: IconBlockquote,
			action: () => applyBlockType('quote'),
			minBp: 2
		},
		{
			id: 'horizontalRule',
			label: m.toolbar_hr(),
			icon: IconSeparator,
			action: () => insertHorizontalRule(editor!),
			disabled: () => toolbarState.inTable,
			minBp: 2
		},
		{
			id: 'table',
			label: m.toolbar_table(),
			icon: IconTable,
			action: handleInsertTable,
			disabled: () => toolbarState.inTable,
			minBp: 2
		},
		{
			id: 'codeBlock',
			label: m.toolbar_code_block(),
			icon: IconCodeDots,
			action: handleInsertCodeBlock,
			disabled: () => toolbarState.inTable,
			minBp: 3
		},
		...ALERT_TYPES.map((type): OverflowItemDef => ({
			id: `callout-${type}`,
			label: `Callout · ${ALERT_LABELS[type]?.()}`,
			icon: ALERT_ICONS[type],
			action: () => insertAlert(editor!, type),
			disabled: () => toolbarState.inTable,
			minBp: 3
		})),
		{
			id: 'tag',
			label: m.toolbar_tag(),
			icon: IconTag,
			action: () => insertTag(editor!),
			minBp: 3
		}
	];

	/** Rare inserts live in the "Insert" menu at every viewport. */
	const INSERT_ITEMS: OverflowItemDef[] = [
		{
			id: 'formula',
			label: m.editor_insert_math(),
			icon: IconMath,
			action: handleInsertMath,
			minBp: 0
		},
		{
			id: 'footnote',
			label: m.editor_insert_footnote(),
			icon: IconNote,
			action: handleInsertFootnote,
			minBp: 0
		},
		{
			id: 'footnoteInline',
			label: m.editor_insert_footnote_inline(),
			icon: IconNote,
			action: handleInsertFootnoteInline,
			minBp: 0
		},
		{
			id: 'mention',
			label: m.editor_insert_mention(),
			icon: IconAt,
			action: handleInsertMention,
			minBp: 0
		},
		{
			id: 'details',
			label: m.editor_insert_details(),
			icon: IconListDetails,
			action: () => insertDetails(editor!),
			disabled: () => toolbarState.inTable,
			minBp: 0
		},
		{
			id: 'embed',
			label: m.editor_insert_embed(),
			icon: IconCards,
			action: handleInsertEmbed,
			disabled: () => toolbarState.inTable,
			minBp: 0
		},
		{
			id: 'mermaid',
			label: m.editor_insert_mermaid(),
			icon: IconChartDots,
			action: () => insertMermaid(editor!),
			disabled: () => toolbarState.inTable,
			minBp: 0
		},
		{
			id: 'tabs',
			label: m.editor_insert_tabs(),
			icon: IconLayoutList,
			action: () => insertTabs(editor!),
			disabled: () => toolbarState.inTable,
			minBp: 0
		},
		{
			id: 'grid',
			label: m.editor_insert_grid(),
			icon: IconLayoutGrid,
			action: () => insertGrid(editor!),
			disabled: () => toolbarState.inTable,
			minBp: 0
		}
	];

	let overflowItems = $derived(OVERFLOW_ITEMS.filter((it) => bp < (it.minBp as number)));
	let overflowNotEmpty = $derived(overflowItems.length > 0);

	// Hide separators on mobile
	let sepClass = $derived(cn(bp < 1 && 'hidden'));
	let ActiveBlockIcon = $derived(activeBlock.icon);
</script>

<div
	bind:this={wrapperEl}
	class={cn(
		'flex w-full min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-1 py-1',
		className
	)}
	role="toolbar"
	aria-label={m.toolbar_editor()}
>
	<!-- ═══════════ Head: block type (level lives in the menu) ═══════════ -->
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					variant="ghost"
					size={bp >= 1 ? 'sm' : 'icon-sm'}
					{...props}
					class="gap-1 text-xs font-medium"
					aria-label={bp < 1 ? m.editor_group_block_type() : undefined}
				>
					<ActiveBlockIcon data-icon="inline-start" />
					<span class={cn('truncate', bp < 1 && 'hidden')}>{activeBlock.label}</span>
					<IconChevronDown class="size-3 opacity-60" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content class="min-w-40">
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>{m.editor_group_block_type()}</DropdownMenu.GroupHeading>
				{#each BLOCK_OPTIONS as option (option.type)}
					{@const OptionIcon = option.icon}
					<DropdownMenu.Item onclick={() => applyBlockType(option.type)}>
						<OptionIcon data-icon="inline-start" />
						{option.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!-- ═══════════ Undo/redo ═══════════ -->
	{#if bp >= 1}
		<Separator orientation="vertical" decorative class={sepClass} />
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => dispatchCmd(UNDO_COMMAND)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_undo()}
		>
			<IconArrowBackUp data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => dispatchCmd(REDO_COMMAND)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_redo()}
		>
			<IconArrowForwardUp data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Text formats: B / I / U / S / Code ═══════════ -->
	<Separator orientation="vertical" decorative class={sepClass} />

	<Button
		variant={toolbarState.isBold ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => formatText('bold')}
		onmousedown={preventSelectionLoss}
		aria-pressed={toolbarState.isBold}
		aria-label={m.toolbar_bold()}
	>
		<IconBold data-icon="inline-start" />
	</Button>
	<Button
		variant={toolbarState.isItalic ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => formatText('italic')}
		onmousedown={preventSelectionLoss}
		aria-pressed={toolbarState.isItalic}
		aria-label={m.toolbar_italic()}
	>
		<IconItalic data-icon="inline-start" />
	</Button>

	{#if bp >= 2}
		<Button
			variant={toolbarState.isUnderline ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatText('underline')}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isUnderline}
			aria-label={m.toolbar_underline()}
		>
			<IconUnderline data-icon="inline-start" />
		</Button>
		<Button
			variant={toolbarState.isStrikethrough ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatText('strikethrough')}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isStrikethrough}
			aria-label={m.toolbar_strikethrough()}
		>
			<IconStrikethrough data-icon="inline-start" />
		</Button>
	{/if}

	{#if bp >= 1}
		<Button
			variant={toolbarState.isCode ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatText('code')}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isCode}
			aria-label={m.toolbar_inline_code()}
		>
			<IconCode data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Highlight / spoiler ═══════════ -->
	{#if bp >= 3}
		<Button
			variant={toolbarState.isHighlight ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatText('highlight')}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isHighlight}
			aria-label={m.toolbar_highlight()}
		>
			<IconHighlight data-icon="inline-start" />
		</Button>
		<Button
			variant={toolbarState.isSpoiler ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => toggleSpoiler(editor!)}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isSpoiler}
			aria-label={m.toolbar_spoiler()}
		>
			<IconEyeOff data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Link / image ═══════════ -->
	<Separator orientation="vertical" decorative class={sepClass} />

	<Button
		variant="ghost"
		size="icon-sm"
		onclick={handleInsertLink}
		onmousedown={preventSelectionLoss}
		aria-label={m.toolbar_link()}
	>
		<IconLink data-icon="inline-start" />
	</Button>
	<Button
		variant="ghost"
		size="icon-sm"
		onclick={handleInsertImage}
		onmousedown={preventSelectionLoss}
		disabled={toolbarState.inTable}
		aria-label={m.toolbar_image()}
	>
		<IconPhoto data-icon="inline-start" />
	</Button>

	<!-- ═══════════ Lists (mutually exclusive) ═══════════ -->
	{#if bp >= 1}
		<Separator orientation="vertical" decorative class={sepClass} />

		<Button
			variant={toolbarState.blockType === 'bullet' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => toggleBulletList(editor!)}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.blockType === 'bullet'}
			aria-label={m.toolbar_ul()}
		>
			<IconList data-icon="inline-start" />
		</Button>
		<Button
			variant={toolbarState.blockType === 'number' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => toggleOrderedList(editor!)}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.blockType === 'number'}
			aria-label={m.toolbar_ol()}
		>
			<IconListNumbers data-icon="inline-start" />
		</Button>
		<Button
			variant={toolbarState.blockType === 'check' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => applyBlockType('check')}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_todo()}
		>
			<IconListCheck data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Blockquote / divider / table ═══════════ -->
	{#if bp >= 2}
		<Separator orientation="vertical" decorative class={sepClass} />

		<Button
			variant={toolbarState.blockType === 'quote' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => applyBlockType('quote')}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_quote()}
		>
			<IconBlockquote data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => insertHorizontalRule(editor!)}
			onmousedown={preventSelectionLoss}
			disabled={toolbarState.inTable}
			aria-label={m.toolbar_hr()}
		>
			<IconSeparator data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={handleInsertTable}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_table()}
		>
			<IconTable data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Code block / Callout / Tag ═══════════ -->
	{#if bp >= 3}
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={handleInsertCodeBlock}
			onmousedown={preventSelectionLoss}
			disabled={toolbarState.inTable}
			aria-label={m.toolbar_code_block()}
		>
			<IconCodeDots data-icon="inline-start" />
		</Button>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						variant="ghost"
						size="icon-sm"
						{...props}
						onmousedown={preventSelectionLoss}
						disabled={toolbarState.inTable}
						aria-label={m.toolbar_callout()}
					>
						<IconInfoCircle data-icon="inline-start" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-36">
				{#each ALERT_TYPES as type (type)}
					{@const Icon = ALERT_ICONS[type]}
					<DropdownMenu.Item onclick={() => insertAlert(editor!, type)}>
						<Icon data-icon="inline-start" />{ALERT_LABELS[type]?.()}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => insertTag(editor!)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_tag()}
		>
			<IconTag data-icon="inline-start" />
		</Button>
	{/if}

	<div class="flex-1"></div>

	<!-- ═══════════ Insert menu: the rare/structural inserts ═══════════ -->
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					variant="ghost"
					size="icon-sm"
					{...props}
					onmousedown={preventSelectionLoss}
					aria-label={m.editor_group_insert()}
					data-testid="toolbar-insert-menu"
				>
					<IconPlus data-icon="inline-start" />
					<IconChevronDown class="size-3 opacity-60" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-44">
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>{m.editor_group_insert()}</DropdownMenu.GroupHeading>
				{#each INSERT_ITEMS as item (item.id)}
					{@const ItemIcon = item.icon}
					{@const itemDisabled = item.disabled?.() ?? false}
					<DropdownMenu.Item onclick={item.action} disabled={itemDisabled}>
						<ItemIcon data-icon="inline-start" />
						{item.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!-- ═══════════ The one overflow collector ═══════════ -->
	{#if overflowNotEmpty}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						variant="ghost"
						size="icon-sm"
						{...props}
						onmousedown={preventSelectionLoss}
						aria-label={m.toolbar_more()}
					>
						<IconDots data-icon="inline-start" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				{#each overflowItems as item (item.id)}
					{@const ItemIcon = item.icon}
					{@const itemDisabled = item.disabled?.() ?? false}
					<DropdownMenu.Item onclick={item.action} disabled={itemDisabled}>
						<ItemIcon data-icon="inline-start" />
						{item.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}

	<!-- ═══════════ Code mode + debug (uniform buttons at the tail) ═══════════ -->
	<Button
		variant={codeMode ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => onToggleCodeMode?.()}
		onmousedown={preventSelectionLoss}
		aria-pressed={codeMode}
		aria-label={codeMode ? m.editor_switch_rich() : m.editor_switch_code()}
		data-testid="toolbar-code-mode"
	>
		{#if codeMode}
			<IconWriting data-icon="inline-start" />
		{:else}
			<IconCode data-icon="inline-start" />
		{/if}
	</Button>
	{#if bp >= 1}
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={openDebug}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_debug()}
			data-testid="toolbar-debug"
		>
			<IconBug data-icon="inline-start" />
		</Button>
	{/if}
</div>

<EditorDebugDialog bind:open={debugOpen} editorStateJson={debugJson} />
<ImageInsertDialog bind:open={imageDialogOpen} onInsert={handleImageInsert} />
<CodeBlockInsertDialog bind:open={codeDialogOpen} onInsert={handleCodeBlockInsert} />
<ValuePromptDialog
	bind:open={promptOpen}
	title={promptTitle}
	label={promptLabel}
	hint={promptHint}
	placeholder={promptPlaceholder}
	onSubmit={(value) => promptSubmit(value)}
/>

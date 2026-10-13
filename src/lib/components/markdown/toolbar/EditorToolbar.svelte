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
	};

	let { editor, class: className }: Props = $props();

	// ── Breakpoint thresholds based on the toolbar wrapper's actual width (ensures zero internal overflow) ──
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

	// wrapperWidth > 0 means the first real measurement is done; until then use the viewportWidth fallback
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
		// The in-place editing overlay takes over (window.prompt is unavailable in embedded browsers/automation environments,
		// and it interrupts the editing context); selection semantics are handled inside LinkHoverEditor.
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
		const latex = window.prompt(m.editor_prompt_latex(), 'E=mc^2');
		if (latex === null) return;
		insertMath(editor, latex.trim() || 'E=mc^2');
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
		shortcut?: string;
		action: () => void;
		/** Lowest breakpoint at which the toolbar shows this item; enters the overflow menu when bp < minBp, 99 = always overflow */
		minBp: BpLevel | 99;
		disabled?: () => boolean;
	}

	interface OverflowGroupDef {
		heading: string;
		items: OverflowItemDef[];
	}

	const ALERT_ICONS: Record<AlertType, typeof IconArticle> = {
		note: IconInfoCircle,
		tip: IconBulb,
		important: IconAlertCircle,
		warning: IconAlertTriangle,
		caution: IconAlertOctagon
	};

	const ALL_OVERFLOW_GROUPS: OverflowGroupDef[] = [
		{
			heading: m.toolbar_text_formats(),
			items: [
				{
					id: 'underline',
					label: m.toolbar_underline(),
					icon: IconUnderline,
					shortcut: '⌘U',
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
				}
			]
		},
		{
			heading: m.editor_group_edit(),
			items: [
				{
					id: 'undo',
					label: m.toolbar_undo(),
					icon: IconArrowBackUp,
					shortcut: '⌘Z',
					action: () => dispatchCmd(UNDO_COMMAND),
					minBp: 1
				},
				{
					id: 'redo',
					label: m.toolbar_redo(),
					icon: IconArrowForwardUp,
					shortcut: '⌘⇧Z',
					action: () => dispatchCmd(REDO_COMMAND),
					minBp: 1
				}
			]
		},
		{
			heading: m.editor_group_lists(),
			items: [
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
					minBp: 2
				}
			]
		},
		{
			heading: m.editor_group_insert(),
			items: [
				{
					id: 'link',
					label: m.md_link_toolbar(),
					icon: IconLink,
					action: handleInsertLink,
					minBp: 0
				},
				{
					id: 'image',
					label: m.editor_insert_image(),
					icon: IconPhoto,
					action: handleInsertImage,
					disabled: () => toolbarState.inTable,
					minBp: 0
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
					label: m.editor_insert_tag(),
					icon: IconTag,
					action: () => insertTag(editor!),
					minBp: 3
				},
				{
					id: 'formula',
					label: m.editor_insert_math(),
					icon: IconMath,
					action: handleInsertMath,
					minBp: 4
				}
			]
		}
	];

	let overflowGroups = $derived(
		ALL_OVERFLOW_GROUPS.map((g) => ({
			heading: g.heading,
			items: g.items.filter((it) => bp < (it.minBp as number))
		})).filter((g) => g.items.length > 0)
	);

	let overflowNotEmpty = $derived(overflowGroups.length > 0);

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
	<!-- ═══════════ Block type dropdown (Tier 0) ═══════════ -->
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					variant="ghost"
					size={bp >= 1 ? 'sm' : 'icon-sm'}
					{...props}
					class="gap-1 text-xs font-medium"
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

	<!-- ═══════════ Undo/redo (Tier 1: sm+) ═══════════ -->
	{#if bp >= 1}
		<Separator orientation="vertical" decorative class={sepClass} />
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => dispatchCmd(UNDO_COMMAND)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_undo()}
			title={`${m.toolbar_undo()} (⌘Z)`}
		>
			<IconArrowBackUp data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => dispatchCmd(REDO_COMMAND)}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_redo()}
			title={`${m.toolbar_redo()} (⌘⇧Z)`}
		>
			<IconArrowForwardUp data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Text formats: B / I / U / S / Code (Tier 0/1/2) ═══════════ -->
	<Separator orientation="vertical" decorative class={sepClass} />

	<Button
		variant={toolbarState.isBold ? 'secondary' : 'ghost'}
		size="icon-sm"
		onclick={() => formatText('bold')}
		onmousedown={preventSelectionLoss}
		aria-pressed={toolbarState.isBold}
		aria-label={m.toolbar_bold()}
		title={`${m.toolbar_bold()} (⌘B)`}
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
		title={`${m.toolbar_italic()} (⌘I)`}
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
			title={`${m.toolbar_underline()} (⌘U)`}
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
			title={m.toolbar_strikethrough()}
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
			title={m.toolbar_inline_code()}
		>
			<IconCode data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Highlight (Tier 3: lg+) ═══════════ -->
	{#if bp >= 3}
		<Button
			variant={toolbarState.isHighlight ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatText('highlight')}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isHighlight}
			aria-label={m.toolbar_highlight()}
			title={m.toolbar_highlight()}
		>
			<IconHighlight data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Spoiler (Tier 3: lg+) ═══════════ -->
	{#if bp >= 3}
		<Button
			variant={toolbarState.isSpoiler ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => toggleSpoiler(editor!)}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.isSpoiler}
			aria-label={m.toolbar_spoiler()}
			title={m.toolbar_spoiler()}
		>
			<IconEyeOff data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Link / image (Tier 0) ═══════════ -->
	<Separator orientation="vertical" decorative class={sepClass} />

	<Button
		variant="ghost"
		size="icon-sm"
		onclick={handleInsertLink}
		onmousedown={preventSelectionLoss}
		aria-label={m.toolbar_link()}
		title={`${m.toolbar_link()} (⌘K)`}
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
		title={toolbarState.inTable ? m.editor_disabled_image() : m.toolbar_image()}
	>
		<IconPhoto data-icon="inline-start" />
	</Button>

	<!-- ═══════════ Lists (mutually exclusive) (Tier 1: sm+) ═══════════ -->
	{#if bp >= 1}
		<Separator orientation="vertical" decorative class={sepClass} />

		<Button
			variant={toolbarState.blockType === 'bullet' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => toggleBulletList(editor!)}
			onmousedown={preventSelectionLoss}
			aria-pressed={toolbarState.blockType === 'bullet'}
			aria-label={m.toolbar_ul()}
			title={m.toolbar_ul()}
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
			title={m.toolbar_ol()}
		>
			<IconListNumbers data-icon="inline-start" />
		</Button>
		<Button
			variant={toolbarState.blockType === 'check' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => applyBlockType('check')}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_todo()}
			title={m.toolbar_todo()}
		>
			<IconListCheck data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Blockquote / divider / table (Tier 2: md+) ═══════════ -->
	{#if bp >= 2}
		<Separator orientation="vertical" decorative class={sepClass} />

		<Button
			variant={toolbarState.blockType === 'quote' ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => applyBlockType('quote')}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_quote()}
			title={m.toolbar_quote()}
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
			title={toolbarState.inTable ? m.editor_disabled_hr() : m.toolbar_hr()}
		>
			<IconSeparator data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={handleInsertTable}
			onmousedown={preventSelectionLoss}
			aria-label={m.toolbar_table()}
			title={m.toolbar_table()}
		>
			<IconTable data-icon="inline-start" />
		</Button>
	{/if}

	<!-- ═══════════ Code block / Callout / Tag (Tier 3: lg+) ═══════════ -->
	{#if bp >= 3}
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={handleInsertCodeBlock}
			onmousedown={preventSelectionLoss}
			disabled={toolbarState.inTable}
			aria-label={m.toolbar_code_block()}
			title={toolbarState.inTable ? m.editor_disabled_code() : m.toolbar_code_block()}
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
						title={toolbarState.inTable ? m.editor_disabled_callout() : m.toolbar_callout()}
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
			title={m.toolbar_tag()}
		>
			<IconTag data-icon="inline-start" />
		</Button>
	{/if}

	<div class="flex-1"></div>

	<!-- ═══════════ Overflow menu (dynamic content) ═══════════ -->
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
						title={m.toolbar_more()}
					>
						<IconDots data-icon="inline-start" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				{#each overflowGroups as group, gi (group.heading)}
					{#if gi > 0}
						<DropdownMenu.Separator />
					{/if}
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading>{group.heading}</DropdownMenu.GroupHeading>
						{#each group.items as item (item.id)}
							{@const ItemIcon = item.icon}
							{@const itemDisabled = item.disabled?.() ?? false}
							<DropdownMenu.Item
								onclick={item.action}
								disabled={itemDisabled}
								title={itemDisabled ? m.editor_disabled_generic() : item.label}
							>
								<ItemIcon data-icon="inline-start" />
								{item.label}
								{#if item.shortcut}
									<span class="ml-auto text-xs text-muted-foreground">{item.shortcut}</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Group>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}

	<!-- ═══════════ Debug (always far right) ═══════════ -->
	<Button
		variant="ghost"
		size="icon-sm"
		onclick={openDebug}
		onmousedown={preventSelectionLoss}
		aria-label={m.toolbar_debug()}
		title={m.toolbar_debug()}
	>
		<IconBug data-icon="inline-start" />
	</Button>
</div>

<EditorDebugDialog bind:open={debugOpen} editorStateJson={debugJson} />
<ImageInsertDialog bind:open={imageDialogOpen} onInsert={handleImageInsert} />
<CodeBlockInsertDialog bind:open={codeDialogOpen} onInsert={handleCodeBlockInsert} />

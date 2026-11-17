<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import type { LexicalEditor } from 'lexical';
	import {
		emptyToolbarState,
		formatTextWithFocus,
		readToolbarState,
		getSelectionRect,
		type ToolbarState
	} from '$lib/components/markdown/editor/lexical-helpers';
	import { openLinkEditor } from './link-editor-channel';

	// ── Icons ──
	import IconBold from '@tabler/icons-svelte-runes/icons/bold';
	import IconItalic from '@tabler/icons-svelte-runes/icons/italic';
	import IconUnderline from '@tabler/icons-svelte-runes/icons/underline';
	import IconStrikethrough from '@tabler/icons-svelte-runes/icons/strikethrough';
	import IconSuperscript from '@tabler/icons-svelte-runes/icons/superscript';
	import IconSubscript from '@tabler/icons-svelte-runes/icons/subscript';
	import IconCode from '@tabler/icons-svelte-runes/icons/code';
	import IconHighlight from '@tabler/icons-svelte-runes/icons/highlight';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';

	// ── Props ──
	type Props = {
		editor: LexicalEditor | null;
	};

	let { editor }: Props = $props();

	// ── Visibility and position ──
	let visible = $state(false);
	let top = $state(0);
	let left = $state(0);

	// ── Format state ──
	let toolbarState = $state<ToolbarState>(emptyToolbarState());

	// ── Track selection changes ──
	$effect(() => {
		if (!editor) return;
		const activeEditor = editor;

		const unregister = activeEditor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				toolbarState = readToolbarState();
			});
		});

		// Listen to native selectionchange to update position and visibility
		function onSelectionChange() {
			const rect = getSelectionRect();
			if (!rect) {
				visible = false;
				return;
			}
			// Position: centred above the selection with a 10px gap
			const toolbarH = 36; // estimated toolbar height
			top = rect.top - toolbarH - 10;
			left = rect.left + rect.width / 2;
			// If there is not enough room above, or it would cover area outside the editor's
			// top edge (e.g. the top toolbar), place it below
			const editorTop = activeEditor.getRootElement()?.getBoundingClientRect().top ?? 8;
			if (top < 8 || top < editorTop) {
				top = rect.bottom + 10;
			}
			visible = true;
		}

		document.addEventListener('selectionchange', onSelectionChange);

		return () => {
			unregister();
			document.removeEventListener('selectionchange', onSelectionChange);
		};
	});

	function handleInsertLink() {
		if (!editor) return;
		// The in-place link editor pane takes over (same channel as the top toolbar)
		openLinkEditor();
	}

	// ── Helper: active-state buttons ──
	function isActive(key: keyof ToolbarState): boolean {
		return !!toolbarState[key];
	}
</script>

{#if visible}
	<div
		class="fixed z-50 flex items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-lg backdrop-blur"
		style="top: {top}px; left: {left}px; transform: translateX(-50%);"
		role="toolbar"
		aria-label={m.toolbar_text_formats()}
		tabindex="-1"
		onmousedown={(e) => e.preventDefault()}
	>
		<!-- Inline format group 1: B I U S -->
		<Button
			variant={isActive('isBold') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'bold')}
			aria-pressed={isActive('isBold')}
			aria-label={m.toolbar_bold()}
			title={`${m.toolbar_bold()} (⌘B)`}
		>
			<IconBold data-icon="inline-start" />
		</Button>
		<Button
			variant={isActive('isItalic') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'italic')}
			aria-pressed={isActive('isItalic')}
			aria-label={m.toolbar_italic()}
			title={`${m.toolbar_italic()} (⌘I)`}
		>
			<IconItalic data-icon="inline-start" />
		</Button>
		<Button
			variant={isActive('isUnderline') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'underline')}
			aria-pressed={isActive('isUnderline')}
			aria-label={m.toolbar_underline()}
			title={`${m.toolbar_underline()} (⌘U)`}
		>
			<IconUnderline data-icon="inline-start" />
		</Button>
		<Button
			variant={isActive('isStrikethrough') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'strikethrough')}
			aria-pressed={isActive('isStrikethrough')}
			aria-label={m.toolbar_strikethrough()}
			title={m.toolbar_strikethrough()}
		>
			<IconStrikethrough data-icon="inline-start" />
		</Button>

		<!-- Divider -->
		<span class="mx-0.5 h-5 w-px bg-border" aria-hidden="true"></span>

		<!-- Inline format group 2: superscript / subscript -->
		<Button
			variant={isActive('isSuperscript') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'superscript')}
			aria-pressed={isActive('isSuperscript')}
			aria-label={m.toolbar_superscript()}
			title={m.toolbar_superscript()}
		>
			<IconSuperscript data-icon="inline-start" />
		</Button>
		<Button
			variant={isActive('isSubscript') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'subscript')}
			aria-pressed={isActive('isSubscript')}
			aria-label={m.toolbar_subscript()}
			title={m.toolbar_subscript()}
		>
			<IconSubscript data-icon="inline-start" />
		</Button>

		<!-- Divider -->
		<span class="mx-0.5 h-5 w-px bg-border" aria-hidden="true"></span>

		<!-- Special formats: inline code / highlight / link -->
		<Button
			variant={isActive('isCode') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'code')}
			aria-pressed={isActive('isCode')}
			aria-label={m.toolbar_inline_code()}
			title={m.toolbar_inline_code()}
		>
			<IconCode data-icon="inline-start" />
		</Button>
		<Button
			variant={isActive('isHighlight') ? 'secondary' : 'ghost'}
			size="icon-sm"
			onclick={() => formatTextWithFocus(editor, 'highlight')}
			aria-pressed={isActive('isHighlight')}
			aria-label={m.toolbar_highlight()}
			title={m.toolbar_highlight()}
		>
			<IconHighlight data-icon="inline-start" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={handleInsertLink}
			aria-label={m.toolbar_link()}
			title={m.toolbar_link()}
		>
			<IconLink data-icon="inline-start" />
		</Button>
	</div>
{/if}

<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import type { LexicalEditor } from 'lexical';
	import {
		emptyToolbarState,
		formatTextWithFocus,
		insertLink,
		readToolbarState,
		getSelectionRect,
		type ToolbarState
	} from '$lib/components/markdown/editor/lexical-helpers';

	// ── 图标 ──
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

	// ── 可见性与位置 ──
	let visible = $state(false);
	let top = $state(0);
	let left = $state(0);

	// ── 格式状态 ──
	let toolbarState = $state<ToolbarState>(emptyToolbarState());

	// ── 监听选区变化 ──
	$effect(() => {
		if (!editor) return;

		const unregister = editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				toolbarState = readToolbarState();
			});
		});

		// 监听原生 selectionchange 以更新位置和可见性
		function onSelectionChange() {
			const rect = getSelectionRect();
			if (!rect) {
				visible = false;
				return;
			}
			// 计算位置：选区上方居中，留 10px 间距
			const toolbarH = 36; // 预估工具栏高度
			top = rect.top - toolbarH - 10;
			left = rect.left + rect.width / 2;
			// 上方空间不足则放到下方
			if (top < 8) {
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
		const url = window.prompt('输入链接地址:', 'https://');
		if (url) {
			insertLink(editor, url.trim());
			editor.focus();
		}
	}

	// ── 辅助：active 态按钮 ──
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
		<!-- 文本格式组 1: B I U S -->
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

		<!-- 分隔 -->
		<span class="mx-0.5 h-5 w-px bg-border" aria-hidden="true"></span>

		<!-- 文本格式组 2: 上标 / 下标 -->
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

		<!-- 分隔 -->
		<span class="mx-0.5 h-5 w-px bg-border" aria-hidden="true"></span>

		<!-- 特殊格式: 行内代码 / 高亮 / 链接 -->
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

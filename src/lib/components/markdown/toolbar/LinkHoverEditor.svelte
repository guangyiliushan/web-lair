<script lang="ts">
	/**
	 * LinkHoverEditor (batch 3b) — in-place link editing for the rich editor.
	 *
	 * Replaces every `window.prompt` link flow with a floating editor that
	 * appears when the caret lands inside a link (view mode: open / edit /
	 * remove) or when a toolbar button requests a new link (edit mode over
	 * the current selection). The pane follows the project's floating-toolbar
	 * pattern (FloatingFormatToolbar): fixed positioning above the target
	 * rect with an editor-top flip guard, and `onmousedown preventDefault`
	 * so the editor selection never blurs into the pane.
	 *
	 * Zero-offset rule: the pane is `position: fixed` — it never adds
	 * inline content, so text geometry in the editor is untouched.
	 *
	 * Official references (verified in this repo's node_modules):
	 * - LinkNode.getURL/setURL — @lexical/link LexicalLinkNode.d.ts:44-45
	 * - unwrap = splice children into parent then remove the link node,
	 *   exactly the $toggleLink(null) collapsed path (LexicalLink.dev.mjs:592-601)
	 * - insertLink — existing project helper (lexical-helpers.ts:133) for the
	 *   create-over-selection flow
	 */
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import {
		$getNodeByKey as getNodeByKey,
		$getSelection as getSelection,
		$isRangeSelection as isRangeSelection,
		type LexicalEditor,
		type LexicalNode
	} from 'lexical';
	import { $isLinkNode as isLinkNode } from '@lexical/link';
	import { insertLink, isSafeLinkUrl } from '../editor/lexical-helpers';
	import { m } from '$lib/paraglide/messages';
	import { OPEN_LINK_EDITOR_EVENT } from './link-editor-channel';

	let { editor }: { editor: LexicalEditor | null } = $props();

	let visible = $state(false);
	type PaneMode = 'view' | 'edit';
	let mode: PaneMode = $state('view');
	let top = $state(0);
	let left = $state(0);
	let url = $state('');
	let linkKey = $state<string | null>(null);
	let inputEl: HTMLInputElement | null = $state(null);

	/** The LinkNode wrapping the caret, or null. */
	function linkAtCaret(): { key: string; url: string } | null {
		if (!editor) return null;
		return editor.getEditorState().read(() => {
			const selection = getSelection();
			if (!isRangeSelection(selection) || !selection.isCollapsed()) return null;
			let node: LexicalNode | null = selection.getNodes()[0] ?? selection.anchor.getNode();
			while (node) {
				if (isLinkNode(node)) return { key: node.getKey(), url: node.getURL() };
				node = node.getParent();
			}
			return null;
		});
	}

	function placeAbove(rect: DOMRect): void {
		const paneH = 40; // 预估高度(与格式条同款口径)
		top = rect.top - paneH - 8;
		const editorTop = editor?.getRootElement()?.getBoundingClientRect().top ?? 8;
		if (top < 8 || top < editorTop) top = rect.bottom + 8;
		left = rect.left + rect.width / 2;
	}

	function openView(): void {
		const hit = linkAtCaret();
		if (!hit || !editor) {
			visible = false;
			return;
		}
		linkKey = hit.key;
		url = hit.url;
		mode = 'view';
		const anchor =
			editor.getElementByKey(hit.key)?.closest('a') ?? editor.getElementByKey(hit.key) ?? null;
		if (!anchor) {
			visible = false;
			return;
		}
		placeAbove(anchor.getBoundingClientRect());
		visible = true;
	}

	/** 创建模式(工具栏入口):光标/选区处浮出编辑态。 */
	function openCreate(): void {
		if (!editor) return;
		const selection = window.getSelection();
		const rect =
			selection && selection.rangeCount > 0
				? selection.getRangeAt(0).getBoundingClientRect()
				: null;
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			// 无可定位选区(如空文档):浮在编辑器顶部
			const rootRect = editor.getRootElement()?.getBoundingClientRect();
			if (!rootRect) return;
			placeAbove(new DOMRect(rootRect.left + rootRect.width / 2, rootRect.top, 0, 0));
		} else {
			placeAbove(rect);
		}
		linkKey = linkAtCaret()?.key ?? null;
		url = linkKey
			? (editor.getEditorState().read(() => {
					const node = linkKey ? getNodeByKey(linkKey) : null;
					return isLinkNode(node) ? node.getURL() : '';
				}) ?? '')
			: '';
		mode = 'edit';
		visible = true;
		requestAnimationFrame(() => inputEl?.focus());
	}

	function applyEdit(): void {
		if (!editor) return;
		const trimmed = url.trim();
		if (!trimmed) {
			removeLink();
			return;
		}
		const key = linkKey;
		if (key) {
			editor.update(() => {
				const node = getNodeByKey(key);
				if (isLinkNode(node)) node.setURL(trimmed);
			});
		} else {
			insertLink(editor, trimmed);
			editor.focus();
		}
		visible = false;
	}

	/** Unwrap keeps the text: the official $toggleLink(null) collapsed path. */
	function removeLink(): void {
		if (!editor || !linkKey) return;
		const key = linkKey;
		editor.update(() => {
			const node = getNodeByKey(key);
			if (!isLinkNode(node)) return;
			const parent = node.getParent();
			if (!parent) return;
			parent.splice(node.getIndexWithinParent(), 0, node.getChildren());
			node.remove();
		});
		visible = false;
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			applyEdit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			if (linkKey) mode = 'view';
			else visible = false;
		}
	}

	$effect(() => {
		if (!editor) return;
		const onSelectionChange = () => {
			if (mode === 'edit') return; // 编辑输入期间不跟随选区
			openView();
		};
		const onOpenRequest = () => openCreate();
		document.addEventListener('selectionchange', onSelectionChange);
		window.addEventListener(OPEN_LINK_EDITOR_EVENT, onOpenRequest);
		return () => {
			document.removeEventListener('selectionchange', onSelectionChange);
			window.removeEventListener(OPEN_LINK_EDITOR_EVENT, onOpenRequest);
		};
	});

	// keep the channel import referenced for the module side of the bus
</script>

{#if visible && editor}
	<div
		class="fixed z-50 flex items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-lg backdrop-blur"
		style="top: {top}px; left: {left}px; transform: translateX(-50%);"
		role="toolbar"
		aria-label={m.md_link_toolbar()}
		tabindex="-1"
		onmousedown={(e) => e.preventDefault()}
	>
		{#if mode === 'view'}
			<a
				class="flex max-w-[16rem] items-center gap-1 truncate px-2 text-xs text-muted-foreground hover:text-foreground"
				href={isSafeLinkUrl(url) ? url : undefined}
				target="_blank"
				rel="noopener noreferrer"
				title={url}
			>
				<IconExternalLink data-icon="inline-start" class="size-3 shrink-0" />
				<span class="truncate">{url}</span>
			</a>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label={m.md_link_edit()}
				onclick={() => {
					mode = 'edit';
					requestAnimationFrame(() => inputEl?.focus());
				}}
			>
				<IconPencil data-icon="inline-start" />
			</Button>
			<Button variant="ghost" size="icon-xs" aria-label={m.md_link_remove()} onclick={removeLink}>
				<IconX data-icon="inline-start" />
			</Button>
		{:else}
			<Input
				bind:ref={inputEl}
				bind:value={url}
				class="h-7 w-64 text-xs"
				placeholder={m.md_link_url()}
				onkeydown={onKeydown}
			/>
			<Button variant="default" size="sm" onclick={applyEdit}>{m.md_link_apply()}</Button>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => {
					if (linkKey) mode = 'view';
					else visible = false;
				}}>{m.md_link_cancel()}</Button
			>
		{/if}
	</div>
{/if}

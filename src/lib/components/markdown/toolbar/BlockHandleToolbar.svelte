<script lang="ts">
	import { onMount } from 'svelte';
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import type { LexicalEditor } from 'lexical';
	import { getLexicalNearestNodeFromDOM } from '$lib/components/markdown/editor/lexical-action';
	import {
		getBlockElement,
		insertBlockAfter,
		turnBlockInto,
		duplicateBlocks,
		moveBlockUp,
		moveBlockDown,
		deleteBlocks
	} from '$lib/components/markdown/editor/lexical-block-helpers';

	// ── Tabler Icons ──
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconGripVertical from '@tabler/icons-svelte-runes/icons/grip-vertical';
	import IconHeading1 from '@tabler/icons-svelte-runes/icons/h-1';
	import IconHeading2 from '@tabler/icons-svelte-runes/icons/h-2';
	import IconHeading3 from '@tabler/icons-svelte-runes/icons/h-3';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconList from '@tabler/icons-svelte-runes/icons/list';
	import IconListNumbers from '@tabler/icons-svelte-runes/icons/list-numbers';
	import IconListCheck from '@tabler/icons-svelte-runes/icons/list-check';
	import IconBlockquote from '@tabler/icons-svelte-runes/icons/blockquote';
	import IconCodeDots from '@tabler/icons-svelte-runes/icons/code-dots';
	import IconSeparator from '@tabler/icons-svelte-runes/icons/separator';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';

	// ── Constants ──
	const HIDE_DELAY = 300;
	const HANDLE_OFFSET = 52;

	interface TurnIntoItem {
		key: string;
		label: string;
		icon: typeof IconArticle;
	}

	const TURN_INTO_ITEMS: TurnIntoItem[] = [
		{ key: 'paragraph', label: '文本', icon: IconArticle },
		{ key: 'h1', label: '标题 1', icon: IconHeading1 },
		{ key: 'h2', label: '标题 2', icon: IconHeading2 },
		{ key: 'h3', label: '标题 3', icon: IconHeading3 },
		{ key: 'bullet', label: '无序列表', icon: IconList },
		{ key: 'numbered', label: '有序列表', icon: IconListNumbers },
		{ key: 'todo', label: '待办列表', icon: IconListCheck },
		{ key: 'quote', label: '引用', icon: IconBlockquote },
		{ key: 'divider', label: '分割线', icon: IconSeparator },
		{ key: 'code', label: '代码块', icon: IconCodeDots }
	];

	// ── Props ──
	type Props = {
		editor: LexicalEditor;
	};

	let { editor }: Props = $props();

	// ── State ──
	let visible = $state(false);
	let top = $state(0);
	let left = $state(0);
	let nodeKey = $state<string | null>(null);
	let gripMenuOpen = $state(false);

	// ── Refs (mutable, not reactive) ──
	let activeBlockElement: HTMLElement | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let isHoveringHandle = false;
	let menuOpenCount = 0;
	let rafId: number | null = null;

	// ── Hide/show helpers ──
	function clearHideTimer() {
		if (hideTimer !== null) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
	}

	function scheduleHide() {
		clearHideTimer();
		hideTimer = setTimeout(() => {
			if (!isHoveringHandle && menuOpenCount === 0) {
				activeBlockElement = null;
				visible = false;
				nodeKey = null;
			}
		}, HIDE_DELAY);
	}

	function onHandleEnter() {
		isHoveringHandle = true;
		clearHideTimer();
	}

	function onHandleLeave() {
		isHoveringHandle = false;
		scheduleHide();
	}

	function onMenuOpenChange(open: boolean) {
		menuOpenCount += open ? 1 : -1;
		if (!open) scheduleHide();
		else clearHideTimer();
	}

	// ── Position update (mirrors original toPagePosition + HANDLE_OFFSET) ──
	function updatePositionFromBlock(block?: HTMLElement | null) {
		if (block !== undefined) activeBlockElement = block;
		const element = activeBlockElement;
		if (!element || !element.isConnected) {
			activeBlockElement = null;
			visible = false;
			nodeKey = null;
			return;
		}

		const rootElement = editor.getRootElement();
		if (!rootElement) return;

		const blockRect = element.getBoundingClientRect();
		const rootRect = rootElement.getBoundingClientRect();

		// 使用 page-relative 坐标（加上 scroll 偏移）
		top = blockRect.top + window.scrollY;
		left = rootRect.left + window.scrollX - HANDLE_OFFSET;

		// 读取 nodeKey
		editor.read(() => {
			const node = getLexicalNearestNodeFromDOM(element);
			nodeKey = node?.getKey() ?? null;
		});

		visible = true;
	}

	// ── Mouse move handler (throttled via rAF, mirrors original) ──
	function onMouseMove(event: MouseEvent) {
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			const target = event.target as HTMLElement;
			const block = getBlockElement(editor, target);
			if (block) {
				clearHideTimer();
				updatePositionFromBlock(block);
			}
		});
	}

	function onMouseLeave() {
		if (!isHoveringHandle && menuOpenCount === 0) {
			scheduleHide();
		}
	}

	// ── Block actions ──
	function handleAddBlock() {
		if (!nodeKey) return;
		insertBlockAfter(editor, nodeKey);
	}

	function handleTurnInto(type: string) {
		if (!nodeKey) return;
		turnBlockInto(editor, nodeKey, type);
	}

	function handleDuplicate() {
		if (!nodeKey) return;
		duplicateBlocks(editor, nodeKey);
	}

	function handleMoveUp() {
		if (!nodeKey) return;
		moveBlockUp(editor, nodeKey);
	}

	function handleMoveDown() {
		if (!nodeKey) return;
		moveBlockDown(editor, nodeKey);
	}

	function handleDelete() {
		if (!nodeKey) return;
		deleteBlocks(editor, nodeKey);
		visible = false;
		nodeKey = null;
	}

	// ── Lifecycle ──
	onMount(() => {
		const rootElement = editor.getRootElement();
		if (!rootElement) return;

		// Mouse tracking on root
		rootElement.addEventListener('mousemove', onMouseMove);
		rootElement.addEventListener('mouseleave', onMouseLeave);

		// Scroll/resize → reposition
		const onScroll = () => updatePositionFromBlock();
		const onResize = () => updatePositionFromBlock();
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onResize);

		// Lexical update → reposition
		const unregisterUpdate = editor.registerUpdateListener(() => updatePositionFromBlock());

		return () => {
			rootElement.removeEventListener('mousemove', onMouseMove);
			rootElement.removeEventListener('mouseleave', onMouseLeave);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onResize);
			unregisterUpdate();
			clearHideTimer();
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	});
</script>

<!-- Block Handle Toolbar -->
<div
	class={cn(
		'absolute z-30 flex items-center gap-px transition-opacity duration-150',
		visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
	)}
	style="top: {top}px; left: {left}px;"
	role="toolbar"
	aria-label="Block actions"
	tabindex="-1"
	onmouseenter={onHandleEnter}
	onmouseleave={onHandleLeave}
>
	<!-- Add Block Button -->
	<Button variant="ghost" size="icon-sm" aria-label="Add block" onclick={handleAddBlock}>
		<IconPlus data-icon="inline-start" />
	</Button>

	<!-- Drag Handle + Dropdown Menu -->
	<DropdownMenu.Root
		open={gripMenuOpen}
		onOpenChange={(open) => {
			gripMenuOpen = open;
			onMenuOpenChange(open);
		}}
	>
		<DropdownMenu.Trigger
			aria-label="Block actions"
			class={cn(
				'inline-flex size-6 cursor-pointer items-center justify-center rounded border-none bg-transparent text-[color-mix(in_srgb,var(--rc-text)_35%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--rc-text)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--rc-text)_70%,transparent)]'
			)}
		>
			<IconGripVertical aria-hidden="true" />
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" side="bottom" sideOffset={4} class="w-48">
			<!-- TURN INTO -->
			<DropdownMenu.Group>
				<DropdownMenu.Label>转换为</DropdownMenu.Label>
				{#each TURN_INTO_ITEMS as item (item.key)}
					<DropdownMenu.Item onclick={() => handleTurnInto(item.key)}>
						<item.icon />
						{item.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Group>

			<DropdownMenu.Separator />

			<!-- ACTIONS -->
			<DropdownMenu.Group>
				<DropdownMenu.Label>操作</DropdownMenu.Label>
				<DropdownMenu.Item onclick={handleDuplicate}>
					<IconCopy />
					复制块
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={handleMoveUp}>
					<IconArrowUp />
					上移
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={handleMoveDown}>
					<IconArrowDown />
					下移
				</DropdownMenu.Item>
			</DropdownMenu.Group>

			<DropdownMenu.Separator />

			<!-- Delete (destructive) -->
			<DropdownMenu.Item variant="destructive" onclick={handleDelete}>
				<IconTrash />
				删除
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

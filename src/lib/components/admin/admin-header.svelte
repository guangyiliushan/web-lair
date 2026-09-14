<script lang="ts">
	import { page } from '$app/state';
	import { Separator } from '$lib/components/ui/separator';
	import { Button } from '$lib/components/ui/button';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { cn } from '$lib/utils';
	import type { Component } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	// Icon lookup table — all icons used by admin header actions
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconFolders from '@tabler/icons-svelte-runes/icons/folders';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconUserPlus from '@tabler/icons-svelte-runes/icons/user-plus';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';

	// ── Icon name → component mapping ──
	const ICON_MAP: Record<string, Component> = {
		'arrow-left': IconArrowLeft,
		'category': IconCategory,
		'external-link': IconExternalLink,
		'eye': IconEye,
		'file-text': IconFileText,
		'folders': IconFolders,
		'message': IconMessage,
		'notebook': IconNotebook,
		'pencil': IconPencil,
		'plus': IconPlus,
		'puzzle': IconPuzzle,
		'settings': IconSettings,
		'sparkles': IconSparkles,
		'tag': IconTag,
		'tool': IconTool,
		'upload': IconUpload,
		'user-plus': IconUserPlus,
		'users': IconUsers,
		'writing': IconWriting
	};

	// ── Internal resolved action type (always uses Component) ──
	interface ResolvedAction {
		label: string;
		icon: Component;
		variant: 'default' | 'outline' | 'ghost';
		size: 'default' | 'sm' | 'lg' | 'icon';
		href?: string;
		onclick?: () => void;
	}

	interface Props {
		/** 显式标题，覆盖 page.data.headerTitle */
		title?: string;
		/** 显式操作按钮（含 Component icon），覆盖 page.data.headerActions */
		actions?: ResolvedAction[];
		class?: string;
	}

	let { title, actions, class: className }: Props = $props();

	// ── 优先使用显式 props，fallback 到 page.data（各页面 load 函数注入）──
	const pageTitle = $derived(
		title ?? page.data.headerTitle ?? m.admin_header_title()
	);

	const pageActions = $derived(
		actions ?? resolveFromPageData(page.data.headerActions)
	);

	function resolveFromPageData(raw: typeof page.data.headerActions): ResolvedAction[] {
		// `undefined` = page didn't specify → use default "访问站点"
		if (raw === undefined) {
			return [
				{
					label: m.admin_header_visit_site(),
					icon: IconExternalLink,
					variant: 'ghost',
					size: 'sm',
					onclick: () => window.open('/', '_blank')
				}
			];
		}
		// page specified (even if []) → use verbatim
		return raw.map((a) => ({
			label: a.label,
			icon: ICON_MAP[a.iconName] ?? IconExternalLink,
			variant: a.variant ?? 'ghost',
			size: a.size ?? 'sm',
			href: a.href,
		}));
	}
</script>

<header
	class={cn(
		'sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur sm:px-6',
		className
	)}
>
	<Sidebar.Trigger class="-ml-1" />
	<Separator orientation="vertical" class="h-6" />
	<div class="flex flex-1 items-center justify-between">
		<div class="flex items-center gap-2">
			<span class="text-sm font-medium text-muted-foreground">{pageTitle}</span>
		</div>
		<div class="flex items-center gap-2">
			{#each pageActions as action (action.label)}
				{@const variant = action.variant ?? 'ghost'}
				{@const size = action.size ?? 'sm'}
				{#if action.href}
					<Button {variant} {size} href={action.href}>
						<action.icon data-icon="inline-start" />
						{action.label}
					</Button>
				{:else}
					<Button {variant} {size} onclick={action.onclick}>
						<action.icon data-icon="inline-start" />
						{action.label}
					</Button>
				{/if}
			{/each}
		</div>
	</div>
</header>

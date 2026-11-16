<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Separator } from '$lib/components/ui/separator';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { cn } from '$lib/utils';
	import type { Component } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import { useAdminHeaderActionRegistry } from './admin-header-actions';
	// Icon lookup table — all icons used by admin header actions
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import IconCloudUpload from '@tabler/icons-svelte-runes/icons/cloud-upload';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconFileImport from '@tabler/icons-svelte-runes/icons/file-import';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconFolders from '@tabler/icons-svelte-runes/icons/folders';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconMicrophone from '@tabler/icons-svelte-runes/icons/microphone';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconTarget from '@tabler/icons-svelte-runes/icons/target';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconUserPlus from '@tabler/icons-svelte-runes/icons/user-plus';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';

	// ── Icon name → component mapping ──
	const ICON_MAP: Record<string, Component> = {
		'arrow-left': IconArrowLeft,
		brain: IconBrain,
		category: IconCategory,
		'chart-bar': IconChartBar,
		'cloud-upload': IconCloudUpload,
		'device-floppy': IconDeviceFloppy,
		'external-link': IconExternalLink,
		eye: IconEye,
		'file-import': IconFileImport,
		'file-text': IconFileText,
		folders: IconFolders,
		message: IconMessage,
		microphone: IconMicrophone,
		notebook: IconNotebook,
		pencil: IconPencil,
		plus: IconPlus,
		puzzle: IconPuzzle,
		refresh: IconRefresh,
		search: IconSearch,
		settings: IconSettings,
		sparkles: IconSparkles,
		tag: IconTag,
		target: IconTarget,
		tool: IconTool,
		upload: IconUpload,
		'user-plus': IconUserPlus,
		users: IconUsers,
		writing: IconWriting
	};

	// ── Internal resolved action type (always uses Component) ──
	interface ResolvedAction {
		label: string;
		icon: Component;
		variant: 'default' | 'outline' | 'ghost';
		size: 'default' | 'sm' | 'lg' | 'icon';
		href?: string;
		/** Page-registered handler id (bound by the page via the action registry). */
		actionId?: string;
		/** When present the button opens this menu instead of acting directly. */
		menu?: Array<{ label: string; href?: string; actionId?: string }>;
		onclick?: () => void;
	}

	interface Props {
		/** Explicit title, overriding page.data.headerTitle */
		title?: string;
		/** Explicit action buttons (with a Component icon), overriding page.data.headerActions */
		actions?: ResolvedAction[];
		class?: string;
	}

	let { title, actions, class: className }: Props = $props();

	// ── Prefer explicit props, fall back to page.data (injected by each page's load) ──
	const pageTitle = $derived(title ?? page.data.headerTitle ?? m.admin_header_title());

	const pageActions = $derived(actions ?? resolveFromPageData(page.data.headerActions));

	const actionRegistry = useAdminHeaderActionRegistry();

	function activate(action: ResolvedAction) {
		action.onclick?.();
		if (action.actionId) actionRegistry?.run(action.actionId);
	}

	function resolveFromPageData(raw: typeof page.data.headerActions): ResolvedAction[] {
		// `undefined` = page didn't specify → use the default "访问站点"
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
			actionId: a.actionId,
			menu: a.menu
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
				{:else if action.menu}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {variant} {size} {...props}>
									<action.icon data-icon="inline-start" />
									{action.label}
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Group>
								{#each action.menu as item (item.label)}
									<DropdownMenu.Item
										onSelect={() => {
											if (item.href) goto(item.href);
											else if (item.actionId) actionRegistry?.run(item.actionId);
										}}
									>
										{item.label}
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Group>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{:else}
					<Button {variant} {size} onclick={() => activate(action)}>
						<action.icon data-icon="inline-start" />
						{action.label}
					</Button>
				{/if}
			{/each}
		</div>
	</div>
</header>

<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconDatabase from '@tabler/icons-svelte-runes/icons/database';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import IconList from '@tabler/icons-svelte-runes/icons/list';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import { cn } from '$lib/utils';
	import type { Component, Snippet } from 'svelte';
	import { m } from '$lib/paraglide/messages';

	let { children }: { children: Snippet } = $props();

	type SectionId =
		| 'user'
		| 'site'
		| 'content'
		| 'notification'
		| 'search'
		| 'storage'
		| 'ai'
		| 'integrations'
		| 'system'
		| 'account'
		| 'meta-preset';

	const sections: { id: SectionId; label: string; desc: string; icon: Component }[] = [
		{
			id: 'user',
			label: m.admin_settings_user(),
			desc: m.admin_settings_user_desc(),
			icon: IconUser
		},
		{
			id: 'site',
			label: m.admin_settings_site(),
			desc: m.admin_settings_site_desc(),
			icon: IconSettings
		},
		{
			id: 'content',
			label: m.admin_settings_content(),
			desc: m.admin_settings_content_desc(),
			icon: IconMail
		},
		{
			id: 'notification',
			label: m.admin_settings_notification(),
			desc: m.admin_settings_notification_desc(),
			icon: IconMail
		},
		{
			id: 'search',
			label: m.admin_settings_search(),
			desc: m.admin_settings_search_desc(),
			icon: IconSearch
		},
		{
			id: 'storage',
			label: m.admin_settings_storage(),
			desc: m.admin_settings_storage_desc(),
			icon: IconDatabase
		},
		{
			id: 'ai',
			label: m.admin_settings_ai(),
			desc: m.admin_settings_ai_desc(),
			icon: IconSparkles
		},
		{
			id: 'integrations',
			label: m.admin_settings_integrations(),
			desc: m.admin_settings_integrations_desc(),
			icon: IconPuzzle
		},
		{
			id: 'system',
			label: m.admin_settings_system(),
			desc: m.admin_settings_system_desc(),
			icon: IconSettings
		},
		{
			id: 'account',
			label: m.admin_settings_account(),
			desc: m.admin_settings_account_desc(),
			icon: IconShield
		},
		{
			id: 'meta-preset',
			label: m.admin_settings_meta_preset(),
			desc: m.admin_settings_meta_preset_desc(),
			icon: IconList
		}
	];

	const isRoot = $derived(page.url.pathname === '/admin/settings');

	function sectionHref(id: SectionId): string {
		return `/admin/settings/${id}`;
	}

	function isActive(id: SectionId): boolean {
		return page.url.pathname === sectionHref(id);
	}

	function activeSection() {
		return sections.find((s) => isActive(s.id));
	}
</script>

<svelte:head>
	<title>{m.admin_settings_title()} - Lair Admin</title>
</svelte:head>

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if isRoot}
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<IconSettings class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="truncate text-sm font-semibold">{m.admin_settings_title()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums"
				>{m.admin_settings_count({ count: sections.length })}</span
			>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each sections as section (section.id)}
				<button
					type="button"
					class={cn(
						'flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
						isActive(section.id) && 'bg-muted/50'
					)}
					onclick={() => goto(sectionHref(section.id))}
				>
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded {isActive(section.id)
							? 'bg-muted-foreground/15'
							: 'bg-muted'}"
					>
						<section.icon class="size-4" />
					</span>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{section.label}</span>
						<span class="mt-0.5 block truncate text-xs text-muted-foreground">{section.desc}</span>
					</span>
				</button>
			{/each}
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<Button
				variant="ghost"
				size="icon"
				class="size-8"
				onclick={() => goto('/admin/settings')}
				aria-label={m.admin_settings_back()}
			>
				<IconArrowLeft data-icon="inline-start" />
			</Button>
			<span class="text-sm font-medium">{activeSection()?.label ?? ''}</span>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			<div class="min-h-full p-4">
				{@render children()}
			</div>
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root>
		<!-- 侧边栏导航 -->
		<MasterDetail.Pane side="master" class="w-80 shrink-0">
			<MasterDetail.Header
				icon={IconSettings}
				title={m.admin_settings_title()}
				count={sections.length}
			/>
			<MasterDetail.List>
				{#each sections as section (section.id)}
					<MasterDetail.Item
						selected={isActive(section.id)}
						onclick={() => goto(sectionHref(section.id))}
					>
						<span
							class="flex size-9 shrink-0 items-center justify-center rounded {isActive(section.id)
								? 'bg-muted-foreground/15'
								: 'bg-muted'}"
						>
							<section.icon class="size-4" />
						</span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium">{section.label}</span>
							<span class="mt-0.5 block truncate text-xs text-muted-foreground">{section.desc}</span
							>
						</span>
					</MasterDetail.Item>
				{/each}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- 内容区 -->
		<MasterDetail.Pane side="detail">
			{#if !isRoot}
				<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<h1 class="truncate text-sm font-medium">{activeSection()?.label ?? ''}</h1>
					<span class="text-xs text-muted-foreground">{activeSection()?.desc ?? ''}</span>
				</div>
			{/if}
			<div class="min-h-0 flex-1 overflow-auto">
				<div class="min-h-full p-4">
					{@render children()}
				</div>
			</div>
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconDatabase from '@tabler/icons-svelte-runes/icons/database';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import type { Component, Snippet } from 'svelte';

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
		| 'account';

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
		}
	];

	/**
	 * Sections are already real routes (`/admin/settings/site`), so the browser
	 * back button closes one on narrow screens with no help from us. This is the
	 * same contract the list-detail shell provides elsewhere — which is why the
	 * shell is reused here rather than shipping a second responsive nav.
	 */
	const active = $derived(sections.find((s) => page.url.pathname.endsWith(`/${s.id}`)) ?? null);
</script>

<svelte:head>
	<title>{m.admin_settings_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={active !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.admin_settings_title()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: sections.length })}
			</span>
		</ListDetail.Toolbar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each sections as section (section.id)}
				<ListDetail.Row href="/admin/settings/{section.id}" selected={active?.id === section.id}>
					<span class="flex size-8 shrink-0 items-center justify-center rounded bg-muted">
						<section.icon class="size-4" />
					</span>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{section.label}</span>
						<span class="mt-0.5 block truncate text-xs text-muted-foreground">
							{section.desc}
						</span>
					</span>
				</ListDetail.Row>
			{/each}
		</div>
	</ListDetail.List>

	<ListDetail.Detail id={active?.id ?? null}>
		{#if active}
			<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
				<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
					{active.label}
				</h1>
				<span class="hidden shrink-0 text-xs text-muted-foreground @min-[32rem]/detail:inline">
					{active.desc}
				</span>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto">
				<div class="min-h-full p-4">{@render children()}</div>
			</div>
		{:else}
			{@render children()}
		{/if}
	</ListDetail.Detail>
</ListDetail.Root>

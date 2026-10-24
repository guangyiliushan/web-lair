<script lang="ts">
	import { page } from '$app/state';
	import { deLocalizeHref } from '$lib/paraglide/runtime';
	import { isActivePath, siteHref } from '$lib/utils/href';
	import { cn } from '$lib/utils';
	import NavMenu from '$lib/components/layout/NavMenu.svelte';
	import {
		navigationConfig,
		tLabel,
		type NavMenuData,
		type PagesMegaData
	} from '$lib/config/navigation.config';
	import type { OwnerStatus, SiteOwner } from '$lib/config/owner-status';

	let {
		owner,
		ownerStatus,
		postsData,
		notesData,
		timelineData,
		pagesData
	}: {
		owner: SiteOwner;
		ownerStatus: OwnerStatus;
		postsData?: NavMenuData | null;
		notesData?: NavMenuData | null;
		timelineData?: NavMenuData | null;
		pagesData?: PagesMegaData | null;
	} = $props();

	const neutralPath = $derived(deLocalizeHref(page.url.pathname));

	function isActive(path: string): boolean {
		return isActivePath(neutralPath, path);
	}
</script>

<nav class="hidden items-center gap-1 lg:flex" aria-label="Main navigation">
	{#each navigationConfig as item (item.key)}
		{#if item.megaMenu}
			<NavMenu
				menu={item.megaMenu}
				triggerAsButton={item.href === '#'}
				{owner}
				{ownerStatus}
				serverData={item.key === 'nav_posts'
					? (postsData ?? null)
					: item.key === 'nav_notes'
						? (notesData ?? null)
						: item.key === 'nav_timeline'
							? (timelineData ?? null)
							: item.key === 'nav_home'
								? (pagesData ?? null)
								: null}
			>
				{#snippet trigger(state)}
					{#if item.href === '#'}
						<button
							{...state.props}
							class={cn(
								'cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary-text',
								'text-muted-foreground'
							)}
						>
							{tLabel(item.labelKey)}
						</button>
					{:else}
						<a
							{...state.props}
							href={siteHref(item.href)}
							class={cn(
								'rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary-text',
								isActive(item.href) ? 'bg-primary/10 text-primary-text' : 'text-muted-foreground'
							)}
						>
							{tLabel(item.labelKey)}
						</a>
					{/if}
				{/snippet}
			</NavMenu>
		{:else}
			<a
				href={siteHref(item.href)}
				class={cn(
					'rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary-text',
					isActive(item.href) ? 'bg-primary/10 text-primary-text' : 'text-muted-foreground'
				)}
			>
				{tLabel(item.labelKey)}
			</a>
		{/if}
	{/each}
</nav>

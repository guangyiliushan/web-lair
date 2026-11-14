<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { deLocalizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { cn } from '$lib/utils';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconLayoutGrid from '@tabler/icons-svelte-runes/icons/layout-grid';
	import IconMap from '@tabler/icons-svelte-runes/icons/map';
	import IconMenu2 from '@tabler/icons-svelte-runes/icons/menu-2';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { slide } from 'svelte/transition';
	import { quartInOut } from 'svelte/easing';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import HeaderShell from '$lib/components/layout/HeaderShell.svelte';
	import SiteBrand from '$lib/components/layout/SiteBrand.svelte';
	import SiteDesktopNav from '$lib/components/layout/SiteDesktopNav.svelte';
	import SiteMobileMenu from '$lib/components/layout/SiteMobileMenu.svelte';
	import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte';
	import LangSwitcher from '$lib/components/layout/LangSwitcher.svelte';
	import UserNav from '$lib/components/account/UserNav.svelte';
	import { getPhotosUi } from '$lib/components/photos/photos-ui.svelte';
	import type { PhotoColumns } from '$lib/photos/query';
	import type { OwnerStatus, SiteOwner } from '$lib/config/owner-status';
	import type { SocialLinkLike } from '$lib/config/social';
	import { ownerPresenceFromStatus, type OwnerPresence } from '$lib/config/owner-presence';
	import type { NavMenuData, PagesMegaData } from '$lib/config/navigation.config';

	type AuthData = {
		user: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image: string | null;
		} | null;
		profile: { displayName: string; avatarUrl: string | null } | null;
	} | null;

	let {
		auth,
		owner,
		ownerLinks,
		ownerStatus,
		ownerPresence,
		postsData,
		notesData,
		timelineData,
		pagesData
	}: {
		auth?: AuthData;
		owner: SiteOwner;
		ownerLinks?: readonly SocialLinkLike[] | null;
		ownerStatus: OwnerStatus;
		ownerPresence?: OwnerPresence | null;
		postsData?: NavMenuData | null;
		notesData?: NavMenuData | null;
		timelineData?: NavMenuData | null;
		pagesData?: PagesMegaData | null;
	} = $props();

	const presence = $derived(ownerPresence ?? ownerPresenceFromStatus(ownerStatus));
	const ui = getPhotosUi();
	const neutralPath = $derived(deLocalizeHref(page.url.pathname));
	const isGallery = $derived(neutralPath === '/photos');
	const title = $derived(neutralPath === '/photos/map' ? m.photos_map_title() : m.photos_title());

	let mobileMenuOpen = $state(false);
	let siteNavOpen = $state(false);

	const columns = [
		{ value: 'auto' as const, label: m.photos_columns_auto() },
		{ value: '3' as const, label: m.photos_columns_three() },
		{ value: '4' as const, label: m.photos_columns_four() },
		{ value: '5' as const, label: m.photos_columns_five() }
	];

	function closeMobileMenu() {
		mobileMenuOpen = false;
	}

	function columnsHref(value: PhotoColumns): string {
		const params = new SvelteURLSearchParams(page.url.searchParams);
		// A column change is a layout preference, not a new feed page.
		params.delete('c');
		if (value === 'auto') params.delete('cols');
		else params.set('cols', value);
		const qs = params.toString();
		return `${siteHref('/photos')}${qs === '' ? '' : `?${qs}`}`;
	}

	function setColumns(value: PhotoColumns) {
		void goto(columnsHref(value), { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

<HeaderShell>
	<div class="flex items-center justify-between gap-2 px-4 py-2">
		<SiteBrand {owner} {presence} />

		<!-- Desktop: photo identity by default, site navigation on demand. -->
		<div class="hidden min-w-0 flex-1 justify-center @min-[56rem]:flex">
			{#if siteNavOpen}
				<SiteDesktopNav
					{owner}
					{ownerLinks}
					{presence}
					{postsData}
					{notesData}
					{timelineData}
					{pagesData}
				/>
			{:else}
				<div class="flex min-w-0 items-baseline gap-2">
					<span class="truncate text-sm font-medium">{title}</span>
					{#if isGallery && ui.photoCount !== null}
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{m.photos_count({ count: ui.photoCount })}
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<div class="flex shrink-0 items-center gap-1">
			<!-- Gallery tools: search / columns / map. They live in the same
			     shell so the header never grows a second row on mobile. -->
			{#if isGallery && !siteNavOpen}
				<button
					type="button"
					onclick={() => ui.openSearch()}
					aria-label={m.photos_search()}
					class="relative inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
				>
					<IconSearch class="size-5" />
					{#if ui.activeFilterCount > 0}
						<span
							class="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground"
						>
							{ui.activeFilterCount}
						</span>
					{/if}
				</button>

				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								variant="ghost"
								size="icon"
								class="size-9 rounded-full"
								aria-label={m.photos_columns()}
								{...props}
							>
								<IconLayoutGrid class="size-5" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" sideOffset={8}>
						<DropdownMenu.Label>{m.photos_columns()}</DropdownMenu.Label>
						<DropdownMenu.Separator />
						{#each columns as column (column.value)}
							<DropdownMenu.Item onSelect={() => setColumns(column.value)}>
								<IconCheck
									class={cn('size-4', ui.columns === column.value ? 'opacity-100' : 'opacity-0')}
								/>
								{column.label}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>

				<a
					href={siteHref('/photos/map')}
					aria-label={m.photos_map_link()}
					class="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
				>
					<IconMap class="size-5" />
				</a>
			{/if}

			<div class="hidden items-center gap-2 @min-[56rem]:flex">
				<LangSwitcher />
				<ThemeToggle />
				<UserNav {auth} />
				<Button
					variant="ghost"
					size="icon"
					class="size-9 rounded-full"
					aria-label={siteNavOpen ? m.photos_close_menu() : m.photos_open_menu()}
					aria-expanded={siteNavOpen}
					onclick={() => (siteNavOpen = !siteNavOpen)}
				>
					{#if siteNavOpen}
						<IconX class="size-5" />
					{:else}
						<IconMenu2 class="size-5" />
					{/if}
				</Button>
			</div>

			<div class="flex items-center gap-1 @min-[56rem]:hidden">
				<LangSwitcher />
				<ThemeToggle />
				<button
					onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
					aria-expanded={mobileMenuOpen}
					aria-label={mobileMenuOpen ? m.ui_close_menu() : m.ui_open_menu()}
					class="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
				>
					{#if mobileMenuOpen}
						<IconX class="size-5" />
					{:else}
						<IconMenu2 class="size-5" />
					{/if}
				</button>
			</div>
		</div>
	</div>

	{#if mobileMenuOpen}
		<div class="overflow-hidden" transition:slide={{ duration: 400, easing: quartInOut }}>
			<SiteMobileMenu {auth} {ownerLinks} {postsData} {pagesData} onclose={closeMobileMenu} />
		</div>
	{/if}
</HeaderShell>

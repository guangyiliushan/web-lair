<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import IconMenu2 from '@tabler/icons-svelte-runes/icons/menu-2';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { slide } from 'svelte/transition';
	import { quartInOut } from 'svelte/easing';
	import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte';
	import LangSwitcher from '$lib/components/layout/LangSwitcher.svelte';
	import HeaderShell from '$lib/components/layout/HeaderShell.svelte';
	import SiteBrand from '$lib/components/layout/SiteBrand.svelte';
	import SiteDesktopNav from '$lib/components/layout/SiteDesktopNav.svelte';
	import SiteMobileMenu from '$lib/components/layout/SiteMobileMenu.svelte';
	import UserNav from '$lib/components/account/UserNav.svelte';
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
		/** Public owner identity — identical for every visitor, never the session. */
		owner: SiteOwner;
		/** `user_profiles.links` — the single social rail source (R-1). */
		ownerLinks?: readonly SocialLinkLike[] | null;
		ownerStatus: OwnerStatus;
		/**
		 * Live pipeline view. Until the ActivityWatch bridge lands, the header
		 * falls back to the static ownerStatus setting for visual preview only.
		 */
		ownerPresence?: OwnerPresence | null;
		postsData?: NavMenuData | null;
		notesData?: NavMenuData | null;
		timelineData?: NavMenuData | null;
		pagesData?: PagesMegaData | null;
	} = $props();

	const presence = $derived(ownerPresence ?? ownerPresenceFromStatus(ownerStatus));

	let menuOpen = $state(false);

	function toggleMenu() {
		menuOpen = !menuOpen;
	}
	function closeMenu() {
		menuOpen = false;
	}
</script>

<HeaderShell>
	<div class="flex items-center justify-between gap-2 px-4 py-2">
		<SiteBrand {owner} {presence} enabled={ownerStatus.enabled} />

		<SiteDesktopNav
			{owner}
			{ownerLinks}
			{ownerStatus}
			{postsData}
			{notesData}
			{timelineData}
			{pagesData}
		/>

		<div class="flex shrink-0 items-center gap-1">
			<div class="hidden items-center gap-2 @min-[56rem]:flex">
				<LangSwitcher />
				<ThemeToggle />
				<UserNav {auth} />
			</div>

			<div class="flex items-center gap-1 @min-[56rem]:hidden">
				<LangSwitcher />
				<ThemeToggle />
				<button
					onclick={toggleMenu}
					aria-expanded={menuOpen}
					aria-label={menuOpen ? m.ui_close_menu() : m.ui_open_menu()}
					class="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
				>
					{#if menuOpen}
						<IconX class="size-5" data-icon="inline-start" />
					{:else}
						<IconMenu2 class="size-5" data-icon="inline-start" />
					{/if}
				</button>
			</div>
		</div>
	</div>

	{#if menuOpen}
		<div class="overflow-hidden" transition:slide={{ duration: 400, easing: quartInOut }}>
			<SiteMobileMenu {auth} {ownerLinks} {postsData} {pagesData} onclose={closeMenu} />
		</div>
	{/if}
</HeaderShell>

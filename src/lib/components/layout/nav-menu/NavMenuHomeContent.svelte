<script lang="ts">
	import { tLabel, type I18nKey, type NavChild } from '$lib/config/navigation.config';
	import type { SiteOwner } from '$lib/config/owner-status';
	import type { OwnerPresence } from '$lib/config/owner-presence';
	import { NAV_HOME_GRID_MAX, NAV_ROWS_PER_COL, navGridColumns } from './geometry';
	import NavMenuHeading from './NavMenuHeading.svelte';
	import NavMenuGridLink from './NavMenuGridLink.svelte';
	import NavMenuProfile from './NavMenuProfile.svelte';
	import NavMenuEmpty from './NavMenuEmpty.svelte';
	import NavMenuSkeleton from './NavMenuSkeleton.svelte';
	import type { SocialLinkLike } from '$lib/config/social';

	/**
	 * Home panel: identity + live stats on the left, the page grid on the right.
	 *
	 * The right side renders dynamic pages only — the social rail (owner links
	 * + fixed RSS) is the left column, so nothing is listed twice (P1b split).
	 */
	let {
		owner,
		presence,
		stats,
		links,
		titleKey,
		items,
		loading = false
	}: {
		owner: SiteOwner;
		presence: OwnerPresence;
		stats: { label: string; value: number | string }[];
		links: readonly SocialLinkLike[] | null | undefined;
		titleKey?: I18nKey;
		items: NavChild[];
		loading?: boolean;
	} = $props();

	function labelOf(child: NavChild): string {
		return child.label ?? tLabel(child.labelKey!);
	}

	const emptyText = $derived(tLabel('nav_menu_empty'));
	/** Fixed slot count: beyond this the grid would outgrow the panel. */
	const visible = $derived(items.slice(0, NAV_HOME_GRID_MAX));
</script>

<!-- `flex-1` lets the two columns fill the panel's fixed height, so the
     profile's social rail can sit on the bottom edge (reference layout). -->
<div class="grid flex-1 gap-0" style:grid-template-columns={navGridColumns()}>
	<NavMenuProfile {owner} {presence} {stats} {links} class="pe-2" />

	<div class="min-w-0 border-s border-border/70 ps-2">
		{#if titleKey}
			<NavMenuHeading text={tLabel(titleKey)} />
		{/if}
		{#if loading}
			<NavMenuSkeleton rows={NAV_ROWS_PER_COL} />
		{:else if visible.length === 0}
			<NavMenuEmpty text={emptyText} />
		{:else}
			<div class="grid grid-cols-2 gap-x-1" data-slot="nav-menu-pages">
				{#each visible as child (child.key ?? child.href)}
					<NavMenuGridLink href={child.href} label={labelOf(child)} />
				{/each}
			</div>
		{/if}
	</div>
</div>

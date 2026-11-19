<script lang="ts">
	import {
		tLabel,
		type I18nKey,
		type NavChild,
		type NavFooter
	} from '$lib/config/navigation.config';
	import { navIcon } from '$lib/config/nav-icons';
	import { NAV_ROWS_PER_COL, navGridColumns } from './geometry';
	import NavMenuHeading from './NavMenuHeading.svelte';
	import NavMenuRow from './NavMenuRow.svelte';
	import NavMenuRecentRow from './NavMenuRecentRow.svelte';
	import NavMenuFooter from './NavMenuFooter.svelte';
	import NavMenuEmpty from './NavMenuEmpty.svelte';
	import NavMenuSkeleton from './NavMenuSkeleton.svelte';

	/**
	 * Two-column panel: categories/topics on the left, recent items on the
	 * right. Used by both the posts and the notes menus.
	 *
	 * Every column resolves to exactly one of loading / empty / rows — never a
	 * heading over nothing.
	 */
	let {
		leftTitleKey,
		leftItems,
		rightTitleKey,
		rightItems,
		footer,
		footerMeta,
		loading = false
	}: {
		leftTitleKey?: I18nKey;
		leftItems: NavChild[];
		rightTitleKey?: I18nKey;
		rightItems: NavChild[];
		footer?: NavFooter;
		footerMeta?: string;
		loading?: boolean;
	} = $props();

	function labelOf(child: NavChild): string {
		return child.label ?? tLabel(child.labelKey!);
	}

	const emptyText = $derived(tLabel('nav_menu_empty'));
	/** 4/4 is what makes the two columns the same height. */
	const visibleLeft = $derived(leftItems.slice(0, NAV_ROWS_PER_COL));
	const visibleRight = $derived(rightItems.slice(0, NAV_ROWS_PER_COL));
</script>

<!-- `flex-1` + default `stretch` makes both columns (and their divider) as
     tall as the panel, so the footer sits on the bottom edge. -->
<div class="grid flex-1 gap-0" style:grid-template-columns={navGridColumns()}>
	<div class="min-w-0 pe-2" data-slot="nav-menu-col-primary">
		{#if leftTitleKey}
			<NavMenuHeading text={tLabel(leftTitleKey)} />
		{/if}
		{#if loading}
			<NavMenuSkeleton rows={NAV_ROWS_PER_COL} />
		{:else if visibleLeft.length === 0}
			<NavMenuEmpty text={emptyText} />
		{:else}
			<div class="flex flex-col">
				{#each visibleLeft as child (child.key ?? child.href)}
					{@const IconComp = child.icon ?? navIcon(child.iconName) ?? undefined}
					<NavMenuRow
						href={child.href}
						label={labelOf(child)}
						icon={IconComp}
						imageUrl={child.imageUrl}
						count={child.badge}
						locked={child.locked}
					/>
				{/each}
			</div>
		{/if}
	</div>

	<div class="min-w-0 border-s border-border/70 ps-2" data-slot="nav-menu-col-secondary">
		{#if rightTitleKey}
			<NavMenuHeading text={tLabel(rightTitleKey)} />
		{/if}
		{#if loading}
			<NavMenuSkeleton rows={NAV_ROWS_PER_COL} />
		{:else if visibleRight.length === 0}
			<NavMenuEmpty text={emptyText} />
		{:else}
			<div class="flex flex-col">
				{#each visibleRight as child (child.key ?? child.href)}
					<NavMenuRecentRow
						href={child.href}
						label={labelOf(child)}
						meta={child.desc ?? (child.descKey ? tLabel(child.descKey) : undefined)}
						kind={child.badge == null ? undefined : String(child.badge)}
						locked={child.locked}
					/>
				{/each}
			</div>
		{/if}
	</div>
</div>

{#if footer}
	<NavMenuFooter
		href={footer.href}
		label={tLabel(footer.labelKey)}
		secondaryHref={footer.secondary?.href}
		secondaryLabel={footer.secondary ? tLabel(footer.secondary.labelKey) : undefined}
		meta={footerMeta}
	/>
{/if}

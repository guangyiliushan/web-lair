<script lang="ts">
	import { siteHref } from '$lib/utils/href';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import LockMark from '$lib/components/notes/LockMark.svelte';
	import { navIcon } from '$lib/config/nav-icons';
	import {
		tLabel,
		type NavChild,
		type NavColumn,
		type NavFooter
	} from '$lib/config/navigation.config';
	import NavMenuHeading from './NavMenuHeading.svelte';
	import NavMenuFooter from './NavMenuFooter.svelte';
	import NavMenuEmpty from './NavMenuEmpty.svelte';
	import NavMenuSkeleton from './NavMenuSkeleton.svelte';

	/**
	 * Simple panel: one or more stacked lists of labelled links.
	 *
	 * Each row is a single horizontal line — icon, label, then the description
	 * and count pushed right. A second line per row would halve how many links
	 * the panel can show.
	 */
	let {
		columns,
		footer,
		footerMeta,
		loading = false
	}: {
		columns: NavColumn[];
		footer?: NavFooter;
		footerMeta?: string;
		loading?: boolean;
	} = $props();

	function labelOf(child: NavChild): string {
		return child.label ?? tLabel(child.labelKey!);
	}

	function descOf(child: NavChild): string | undefined {
		return child.desc ?? (child.descKey ? tLabel(child.descKey) : undefined);
	}

	const emptyText = $derived(tLabel('nav_menu_empty'));
	const hasRows = $derived(columns.some((column) => column.items.length > 0));
</script>

<div class="flex-1">
	{#if loading}
		<NavMenuSkeleton rows={5} />
	{:else if !hasRows}
		<NavMenuEmpty text={emptyText} />
	{:else}
		{#each columns as column, i (i)}
			{#if column.titleKey}
				<NavMenuHeading text={tLabel(column.titleKey)} />
			{/if}
			{#if column.items.length === 0}
				<NavMenuEmpty text={emptyText} class="mb-1" />
			{:else}
				<div class="flex flex-col">
					{#each column.items as child (child.key ?? child.href)}
						{@const IconComp = child.icon ?? navIcon(child.iconName) ?? undefined}
						{@const desc = descOf(child)}
						<a
							href={siteHref(child.href)}
							class="group/row relative flex h-7 items-center gap-1.5 px-1.5 text-xs leading-none text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							<span
								aria-hidden="true"
								class="absolute inset-s-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary-text opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
							></span>
							{#if IconComp}
								<IconComp class="size-3.5 shrink-0 opacity-70" />
							{/if}
							<span class="min-w-0 truncate">{labelOf(child)}</span>
							{#if child.locked}
								<LockMark />
							{/if}
							<span class="ms-auto flex min-w-0 shrink items-center gap-1.5">
								{#if desc}
									<span class="max-w-32 min-w-0 truncate text-muted-foreground">{desc}</span>
								{/if}
								{#if child.badge}
									<Badge
										variant="secondary"
										class="h-4.5 rounded-md px-1.5 text-[11px] tabular-nums"
									>
										{child.badge}
									</Badge>
								{/if}
							</span>
						</a>
					{/each}
				</div>
			{/if}
			{#if i < columns.length - 1}
				<Separator class="my-1" role="separator" />
			{/if}
		{/each}
	{/if}
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

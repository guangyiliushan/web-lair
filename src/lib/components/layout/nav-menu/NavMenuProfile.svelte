<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';
	import { tLabel } from '$lib/config/navigation.config';
	import { Separator } from '$lib/components/ui/separator';
	import type { Component } from 'svelte';
	import type { OwnerStatus, SiteOwner } from '$lib/config/owner-status';

	/**
	 * Left column of the home panel: identity, stat strip, social rail.
	 *
	 * Everything sits on one horizontal line per band — name + online light in
	 * one row, the three stats side by side, the social icons in a single row.
	 * Only the band itself stacks.
	 *
	 * The identity row carries no avatar and no activity ticket on purpose: the
	 * header already shows both, and the panel only needs to say *who* this is
	 * and whether they are around.
	 */
	let {
		owner,
		status,
		stats,
		social,
		class: className
	}: {
		owner: SiteOwner;
		status: OwnerStatus;
		/** Pre-resolved rows; rendered left to right. */
		stats: { label: string; value: number | string }[];
		social: { href: string; label: string; icon?: Component }[];
		class?: string;
	} = $props();

	// `idle` is the owner's "away" state (StatusTicket reads it the same way);
	// a disabled ticket means the activity feed is off, so treat it as away.
	const online = $derived(status.enabled && status.kind !== 'idle');
	const onlineLabel = $derived(tLabel('nav_home_owner_online'));
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	<div class="flex min-w-0 items-center gap-1.5">
		<div class="min-w-0 truncate text-xs font-semibold">{owner.name}</div>
		{#if online}
			<span class="relative flex size-1.5 shrink-0" role="img" aria-label={onlineLabel}>
				<span
					class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none"
				></span>
				<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
			</span>
		{/if}
	</div>

	<!-- Stat stack: one row per figure. Stacking (not a three-across strip)
	     gives each number the full column width, so four- or five-digit counts
	     still read as a single figure instead of squeezing their label out. -->
	<dl class="mt-0.5 flex flex-col gap-3">
		{#each stats as row (row.label)}
			<div class="flex min-w-0 items-baseline gap-2">
				<dd class="font-mono text-2xl leading-none font-semibold text-foreground tabular-nums">
					{row.value}
				</dd>
				<dt class="min-w-0 truncate text-xs leading-none text-muted-foreground">
					{row.label}
				</dt>
			</div>
		{/each}
	</dl>

	<!-- Pushed to the bottom edge: identity + figures stay at the top, the
	     social rail closes the column (reference layout). -->
	<Separator class="my-0.5 mt-auto" />

	<div class="flex items-center gap-0.5" data-slot="nav-menu-social">
		{#each social as item (item.href)}
			{@const IconComp = item.icon}
			<a
				href={siteHref(item.href)}
				aria-label={item.label}
				class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				{#if IconComp}
					<IconComp class="size-3.5" />
				{/if}
			</a>
		{/each}
	</div>
</div>

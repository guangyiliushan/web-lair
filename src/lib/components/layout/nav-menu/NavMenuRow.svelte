<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';
	import { Badge } from '$lib/components/ui/badge';
	import LockMark from '$lib/components/notes/LockMark.svelte';
	import type { Component } from 'svelte';

	/**
	 * Primary row in a panel's left column (categories / topics).
	 *
	 * One horizontal line: icon, label, lock, then the count hard-right. Every
	 * field is already resolved to a renderable value so this stays display-only.
	 */
	let {
		href,
		label,
		icon,
		imageUrl,
		count,
		locked = false,
		class: className
	}: {
		href: string;
		label: string;
		icon?: Component;
		imageUrl?: string;
		count?: string | number;
		locked?: boolean;
		class?: string;
	} = $props();

	const showTrail = $derived(count !== undefined && count !== null && count !== '');
</script>

<a
	href={siteHref(href)}
	class={cn(
		'group/row relative flex h-7 items-center gap-1.5 px-1.5 text-xs leading-none text-muted-foreground transition-colors',
		'hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
		className
	)}
>
	<span
		aria-hidden="true"
		class="absolute inset-s-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary-text opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
	></span>
	{#if imageUrl}
		<img src={imageUrl} alt="" class="size-3.5 shrink-0 rounded-[3px] object-cover" />
	{:else if icon}
		{@const IconComp = icon}
		<IconComp class="size-3.5 shrink-0 opacity-70" />
	{/if}
	<span class="min-w-0 truncate">{label}</span>
	{#if locked}
		<LockMark />
	{/if}
	{#if showTrail}
		<Badge variant="secondary" class="ms-auto h-4.5 rounded-md px-1.5 text-[11px] tabular-nums">
			{count}
		</Badge>
	{/if}
</a>

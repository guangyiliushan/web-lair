<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getContext } from 'svelte';

	/**
	 * The list pane. Below 840px it yields the whole width to the detail when
	 * one is open; at 840px and up it is a fixed 20rem column beside it.
	 */
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();

	const shell = getContext<{ detailOpen: boolean }>('list-detail:shell');
</script>

<div
	bind:this={ref}
	data-slot="list-detail-list"
	class={cn(
		'min-w-0 flex-col',
		// Single pane: step aside while a detail is showing.
		shell.detailOpen ? 'hidden' : 'flex',
		// Two panes: always present, fixed column.
		'@min-[840px]/list-detail:flex @min-[840px]/list-detail:w-80 @min-[840px]/list-detail:shrink-0 @min-[840px]/list-detail:border-r',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>

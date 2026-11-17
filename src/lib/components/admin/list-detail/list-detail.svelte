<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { setContext } from 'svelte';

	/**
	 * Admin list-detail shell.
	 *
	 * One markup tree owns both the two-pane and the single-pane layout. The
	 * pane count is decided by a **container** query at 840px — Material 3's
	 * Expanded lower bound, where two panes become recommended — not by a
	 * viewport query. The admin sidebar is collapsible, so the space actually
	 * available to this shell is not the window width.
	 *
	 * Under 840px only one pane shows at a time: the list when nothing is
	 * selected, the detail when something is ("Only one view is
	 * visible at a time, either list or detail"). `detailOpen` drives that.
	 */
	let {
		ref = $bindable(null),
		detailOpen = false,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** Whether a detail is currently shown. Drives single-pane switching. */
		detailOpen?: boolean;
	} = $props();

	// Mutable state object rather than a bare value: `setContext` runs once at
	// init, so the shared handle has to carry later changes itself.
	const shell = $state({ detailOpen: false });
	$effect(() => {
		shell.detailOpen = detailOpen;
	});
	setContext('list-detail:shell', shell);
</script>

<div
	bind:this={ref}
	data-slot="list-detail"
	data-detail-open={detailOpen ? '' : undefined}
	class={cn('@container/list-detail flex min-h-0 flex-1', className)}
	{...restProps}
>
	{@render children?.()}
</div>

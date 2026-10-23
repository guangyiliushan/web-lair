<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getContext, type Snippet } from 'svelte';

	/**
	 * The detail pane — an inspector panel (Apple HIG "Panels"), not a sheet.
	 * It stays mounted beside the list at 840px+, and takes over the whole
	 * width below that while a record is selected.
	 *
	 * The slide-in is CSS, not a Svelte `transition:` directive. Svelte
	 * transitions run on the Web Animations API and are therefore immune to a
	 * global `@media (prefers-reduced-motion: reduce)` rule, and the JS-side
	 * substitute (`prefersReducedMotion`) is an SSR-unsafe `MediaQuery`. CSS
	 * gets both for free and is what the Svelte docs recommend when it can do
	 * the job.
	 */
	let {
		ref = $bindable(null),
		/** Selected record id. Changing it re-runs the enter animation. */
		id,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		id?: string | null;
		children: Snippet;
	} = $props();

	const shell = getContext<{ detailOpen: boolean }>('list-detail:shell');
</script>

<div
	bind:this={ref}
	data-slot="list-detail-detail"
	class={cn(
		'min-w-0 flex-col',
		// Single pane: only present while a record is selected.
		shell.detailOpen ? 'flex flex-1' : 'hidden',
		// Two panes: always present, absorbs the remaining width.
		'@min-[840px]/list-detail:flex @min-[840px]/list-detail:flex-1',
		className
	)}
	{...restProps}
>
	{#key id}
		<div class="list-detail-enter flex min-h-0 flex-1 flex-col">
			{@render children()}
		</div>
	{/key}
</div>

<style>
	@keyframes list-detail-enter {
		from {
			opacity: 0;
			transform: translateX(0.75rem);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	/* Only animate for users who have not asked for less motion. */
	@media (prefers-reduced-motion: no-preference) {
		.list-detail-enter {
			animation: list-detail-enter 160ms ease-out;
		}
	}
</style>

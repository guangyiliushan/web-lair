<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * Flat one-line toolbar at the top of the list pane.
	 *
	 * Borderless, bare controls, no boxed chrome and no "label above control"
	 * stacking — the admin list header convention. Column labels stay as
	 * `sr-only` names when a control occupies their place.
	 */
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="list-detail-toolbar"
	class={cn('flex h-11 shrink-0 items-center gap-2 border-b px-3', className)}
	{...restProps}
>
	{@render children?.()}
</div>

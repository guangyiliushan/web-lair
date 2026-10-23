<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	/**
	 * A selectable row in the list pane. It is a real link, so the selection is
	 * a real navigation — back, focus restore and route announcements come from
	 * the framework rather than from us.
	 */
	let {
		ref = $bindable(null),
		class: className,
		selected = false,
		href,
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		selected?: boolean;
		href: string;
	} = $props();
</script>

<a
	bind:this={ref}
	{href}
	data-slot="list-detail-row"
	data-selected={selected || undefined}
	aria-current={selected ? 'page' : undefined}
	class={cn(
		// 48px hit target: satisfies WCAG 2.5.8 (24px AA) with room to spare,
		// and matches Material's 48dp accessible minimum.
		'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
		'[@media(hover:hover)]:hover:bg-muted/50',
		selected && 'bg-accent',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</a>

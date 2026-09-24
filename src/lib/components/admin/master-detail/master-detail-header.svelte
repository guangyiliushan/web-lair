<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Component } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		icon: Icon,
		title,
		count,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		icon?: Component;
		title: string;
		count?: number;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="master-detail-header"
	class={cn('flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4', className)}
	{...restProps}
>
	<div class="flex min-w-0 items-center gap-2">
		{#if Icon}
			<Icon class="size-4 shrink-0 text-muted-foreground" />
		{/if}
		<h2 class="truncate text-sm font-semibold">{title}</h2>
	</div>
	<div class="flex shrink-0 items-center gap-2">
		{#if count !== undefined}
			<span class="text-xs text-muted-foreground tabular-nums">{count} 个</span>
		{/if}
		{@render children?.()}
	</div>
</div>

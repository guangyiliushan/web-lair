<script lang="ts">
	import { cn } from '$lib/utils';
	import { Skeleton } from '$lib/components/ui/skeleton';

	/**
	 * Loading placeholder sized to the rows it stands in for, so the panel
	 * keeps its height and never collapses to a heading over nothing.
	 */
	let {
		rows = 4,
		height = 'h-7',
		class: className
	}: {
		rows?: number;
		/** Matches the row height of the column being replaced. */
		height?: 'h-7' | 'h-6';
		class?: string;
	} = $props();

	const slots = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<div class={cn('flex flex-col gap-0.5', className)} aria-hidden="true">
	{#each slots as i (i)}
		<Skeleton class={cn(height, 'w-full rounded-md')} />
	{/each}
</div>

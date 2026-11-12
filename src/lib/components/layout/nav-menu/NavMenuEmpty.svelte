<script lang="ts">
	import { cn } from '$lib/utils';

	/**
	 * Empty placeholder for a panel column.
	 *
	 * The panels are dense indexes of 28px rows, so an empty column gets one
	 * muted line on the same grid — no card, border or icon. Chrome around
	 * "nothing" only competes with the rows that do exist.
	 */
	let {
		text,
		class: className
	}: {
		text: string;
		class?: string;
	} = $props();
</script>

<p
	class={cn('flex min-h-7 items-center px-1.5 text-xs leading-5 text-muted-foreground', className)}
>
	{text}
</p>

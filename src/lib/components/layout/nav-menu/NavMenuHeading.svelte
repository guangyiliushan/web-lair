<script lang="ts">
	import { cn } from '$lib/utils';

	/**
	 * Group heading inside a nav panel.
	 *
	 * Kept on one line with tight tracking: it labels a column, it does not
	 * introduce a section. Spacing is deliberately minimal — the panel is a
	 * dense index, not a card.
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
	class={cn(
		'mb-0.5 px-1.5 text-[11px] leading-5 font-medium tracking-[1.5px] text-muted-foreground uppercase',
		className
	)}
>
	{text}
</p>

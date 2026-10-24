<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';
	import LockMark from '$lib/components/notes/LockMark.svelte';

	/**
	 * Compact row in a panel's right column (recent posts / notes / activity).
	 *
	 * One line: fixed date cell, title truncating, then the entry kind and a
	 * lock marker. `meta` must arrive pre-compacted to `month·day`.
	 *
	 * `kind` is display-only. The caller reads it off `NavChild.badge`, which is
	 * the only trailing-annotation slot on that shape — the left column uses the
	 * same field for a count.
	 */
	let {
		href,
		label,
		meta,
		kind,
		locked = false,
		class: className
	}: {
		href: string;
		label: string;
		meta?: string;
		kind?: string;
		locked?: boolean;
		class?: string;
	} = $props();
</script>

<a
	href={siteHref(href)}
	class={cn(
		'group/row relative grid h-7 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2 px-1.5 text-xs leading-none',
		'text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground',
		'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
		className
	)}
>
	<span
		aria-hidden="true"
		class="absolute start-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary-text opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
	></span>
	{#if meta}
		<span class="font-mono text-[11px] text-muted-foreground tabular-nums">{meta}</span>
	{/if}
	<span class="min-w-0 truncate">{label}</span>
	<span class="flex shrink-0 items-center gap-1.5">
		{#if kind}
			<span class="text-[10px] font-medium tracking-[1px] text-muted-foreground uppercase">
				{kind}
			</span>
		{/if}
		{#if locked}
			<LockMark />
		{/if}
	</span>
</a>

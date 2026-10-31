<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';
	import { Badge } from '$lib/components/ui/badge';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';

	/**
	 * Panel footer, one line: primary link, then an optional count badge and an
	 * optional second link on the right. Both two-column panels share it, so the
	 * order is fixed here once.
	 */
	let {
		href,
		label,
		secondaryHref,
		secondaryLabel,
		meta,
		class: className
	}: {
		href: string;
		label: string;
		secondaryHref?: string;
		secondaryLabel?: string;
		meta?: string;
		class?: string;
	} = $props();

	const linkClass =
		'flex items-center gap-0.5 text-[11px] leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';
</script>

<div
	class={cn(
		'mt-1 flex items-center justify-between gap-2 border-t border-border/70 px-1.5 py-1',
		className
	)}
>
	<a href={siteHref(href)} class={linkClass}>
		{label}
		<IconChevronRight class="size-3" aria-hidden="true" />
	</a>
	<div class="flex min-w-0 items-center gap-1.5">
		{#if meta}
			<Badge variant="secondary" class="h-4.5 rounded-md px-1.5 text-[11px] tabular-nums">
				{meta}
			</Badge>
		{/if}
		{#if secondaryHref && secondaryLabel}
			<a href={siteHref(secondaryHref)} class={cn(linkClass, 'min-w-0')}>
				<span class="truncate">{secondaryLabel}</span>
				<IconChevronRight class="size-3 shrink-0" aria-hidden="true" />
			</a>
		{/if}
	</div>
</div>

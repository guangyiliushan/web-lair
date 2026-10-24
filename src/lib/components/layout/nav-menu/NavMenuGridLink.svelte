<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';

	/** Flat one-line link cell for the home panel's page grid. */
	let {
		href,
		label,
		class: className
	}: {
		href: string;
		label: string;
		class?: string;
	} = $props();
</script>

<a
	href={siteHref(href)}
	class={cn(
		'flex h-7 items-center rounded-md px-1.5 text-xs leading-none text-muted-foreground transition-colors',
		'hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
		className
	)}
>
	<span class="min-w-0 truncate">{label}</span>
</a>

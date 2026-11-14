<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		actions,
		children
	}: {
		title: string;
		description?: string;
		actions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="space-y-3">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 class="text-sm font-medium">{title}</h2>
			{#if description}
				<p class="mt-1 text-xs text-muted-foreground">{description}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
		{/if}
	</header>
	<dl class="divide-y overflow-hidden rounded-lg border">
		{@render children()}
	</dl>
</section>

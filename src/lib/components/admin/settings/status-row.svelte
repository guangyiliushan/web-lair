<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';

	let {
		label,
		value = '',
		hint,
		badge
	}: {
		label: string;
		value?: string;
		hint?: string;
		badge?: string;
	} = $props();
</script>

<div class="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
	<div class="min-w-0">
		<dt class="text-sm">{label}</dt>
		{#if hint}
			<p class="mt-0.5 text-xs text-muted-foreground">{hint}</p>
		{/if}
	</div>
	<dd class="min-w-0 text-sm break-words text-muted-foreground sm:text-right">
		{#if badge}
			<Badge variant="secondary">{badge}</Badge>
		{:else}
			{value || '—'}
		{/if}
	</dd>
</div>

<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';

	export type ProviderState = 'configured' | 'not_configured' | 'planned' | 'error';

	let {
		name,
		state,
		detail
	}: {
		name: string;
		state: ProviderState;
		detail?: string;
	} = $props();

	const label = $derived(
		state === 'configured'
			? m.admin_settings_common_configured()
			: state === 'not_configured'
				? m.admin_settings_common_not_configured()
				: state === 'planned'
					? m.admin_settings_integrations_planned()
					: m.admin_settings_common_error()
	);
	const variant = $derived(
		state === 'configured' ? 'default' : state === 'error' ? 'destructive' : 'secondary'
	);
</script>

<div class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
	<div class="min-w-0">
		<p class="text-sm">{name}</p>
		{#if detail}
			<p class="mt-0.5 text-xs text-muted-foreground">{detail}</p>
		{/if}
	</div>
	<div class="flex shrink-0 items-center gap-2">
		<Badge {variant}>{label}</Badge>
	</div>
</div>

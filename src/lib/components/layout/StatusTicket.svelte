<script lang="ts">
	import OwnerAppIcon from './OwnerAppIcon.svelte';
	import type { OwnerPresence } from '$lib/config/owner-presence';

	/**
	 * Pure inline owner-status visual. The header HoverCard owns the trigger,
	 * card, and fit measurement; this component only paints the dot, app icon,
	 * and the optional hover-revealed app name.
	 */
	let {
		presence,
		showAppIcon,
		showInlineName
	}: {
		presence: OwnerPresence;
		showAppIcon: boolean;
		showInlineName: boolean;
	} = $props();
</script>

<span
	class="flex min-w-0 items-center gap-1.5"
	data-slot="owner-status"
	data-state={presence.state}
>
	{#if presence.state === 'online'}
		{#if presence.activity === 'listening'}
			<span class="flex h-3 shrink-0 items-end gap-[2px]" aria-hidden="true">
				<span
					class="w-[2px] animate-pulse rounded-full bg-primary motion-reduce:animate-none"
					style="height: 55%; animation-delay: 0ms"
				></span>
				<span
					class="w-[2px] animate-pulse rounded-full bg-primary motion-reduce:animate-none"
					style="height: 100%; animation-delay: 160ms"
				></span>
				<span
					class="w-[2px] animate-pulse rounded-full bg-primary motion-reduce:animate-none"
					style="height: 70%; animation-delay: 320ms"
				></span>
			</span>
		{:else}
			<span class="relative flex size-1.5 shrink-0" aria-hidden="true" data-slot="owner-status-dot">
				<span
					class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none"
				></span>
				<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
			</span>
		{/if}
	{/if}

	{#if showAppIcon && presence.app}
		<OwnerAppIcon app={presence.app} size={20} muted={presence.state === 'offline'} />
	{/if}

	{#if showInlineName && presence.app}
		<span
			class="pointer-events-none absolute top-1/2 left-full ml-1.5 -translate-y-1/2 text-[11px] leading-none font-medium whitespace-nowrap text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/status:pointer-events-auto group-hover/status:opacity-100 group-focus-visible/status:pointer-events-auto group-focus-visible/status:opacity-100"
			data-slot="owner-status-app-name"
			aria-hidden="true"
		>
			{presence.app.name}
		</span>
	{/if}
</span>

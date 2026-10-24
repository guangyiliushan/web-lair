<script lang="ts">
	import IconAppWindow from '@tabler/icons-svelte-runes/icons/app-window';
	import IconBrandVscode from '@tabler/icons-svelte-runes/icons/brand-vscode';
	import { cn } from '$lib/utils';
	import type { OwnerPresenceApp } from '$lib/config/owner-presence';

	let {
		app,
		size = 20,
		muted = false
	}: {
		app: OwnerPresenceApp | null;
		size?: number;
		muted?: boolean;
	} = $props();

	const isImage = $derived(app?.icon ? /^(?:\/|https:\/\/|data:image\/)/.test(app.icon) : false);
	const isVscode = $derived(/visual studio code|vs code|^code$/i.test(app?.name ?? ''));
	const Icon = $derived(isVscode ? IconBrandVscode : IconAppWindow);
</script>

<span
	class={cn(
		'grid shrink-0 place-items-center overflow-hidden rounded-[5px] border border-border/70 bg-muted/40 text-muted-foreground',
		muted && 'opacity-55 grayscale'
	)}
	style:width={`${size}px`}
	style:height={`${size}px`}
	data-slot="owner-status-app-icon"
	aria-hidden="true"
>
	{#if isImage && app}
		<img
			src={app.icon}
			alt=""
			class="size-full object-cover"
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
		/>
	{:else}
		<Icon class={size >= 32 ? 'size-6' : 'size-3.5'} />
	{/if}
</span>

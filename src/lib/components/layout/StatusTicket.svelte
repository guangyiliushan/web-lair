<script lang="ts">
	import { siteHref } from '$lib/utils/href';
	import type { OwnerStatus } from '$lib/config/owner-status';

	/**
	 * Owner activity ticket (static stage): one datum only — the app/site name
	 * capped at ten characters, optionally preceded by its icon. No localised
	 * copy here on purpose: the text is owner-authored, so the badge reads the
	 * same in every locale.
	 */
	let { status }: { status: OwnerStatus } = $props();

	const MAX_CHARS = 10;

	const full = $derived(status.detail.trim());
	// Code points, not UTF-16 units: an emoji in the name must not be split.
	const visible = $derived(
		status.kind === 'idle' ? '' : Array.from(full).slice(0, MAX_CHARS).join('')
	);
	const truncated = $derived(visible !== '' && visible !== full);
</script>

{#if status.enabled && visible}
	<svelte:element
		this={status.href ? 'a' : 'div'}
		href={status.href ? siteHref(status.href) : undefined}
		class="flex h-8 max-w-[11rem] min-w-0 items-center gap-1.5 rounded-md px-1.5"
		title={full}
		data-slot="owner-status"
	>
		{#if status.iconUrl}
			<img
				src={status.iconUrl}
				alt=""
				loading="lazy"
				class="size-5 shrink-0 rounded-[3px] object-cover"
			/>
		{/if}

		{#if truncated}
			<span class="truncate text-sm font-medium" aria-hidden="true">{visible}</span>
			<span class="sr-only">{full}</span>
		{:else}
			<span class="truncate text-sm font-medium">{visible}</span>
		{/if}

		{#if status.kind === 'listening'}
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
			<span class="relative flex size-1.5 shrink-0" aria-hidden="true">
				<span
					class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none"
				></span>
				<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
			</span>
		{/if}
	</svelte:element>
{/if}

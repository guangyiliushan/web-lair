<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconChevronLeft from '@tabler/icons-svelte-runes/icons/chevron-left';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { siteHref } from '$lib/utils/href';

	let {
		title,
		position,
		infoOpen,
		onToggleInfo,
		newerHref,
		olderHref
	}: {
		title: string;
		position: { index: number; total: number };
		infoOpen: boolean;
		onToggleInfo: () => void;
		newerHref: string | null;
		olderHref: string | null;
	} = $props();

	const iconButton =
		'inline-flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none';
</script>

<header
	class="fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-2 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-2 text-white sm:px-3"
>
	<a href={siteHref('/photos')} class={iconButton} aria-label={m.photos_back()}>
		<IconArrowLeft class="size-5" />
	</a>

	<div class="min-w-0 flex-1">
		<p class="truncate text-sm font-medium">{title}</p>
	</div>

	<span class="shrink-0 text-xs text-white/60 tabular-nums" aria-live="polite">
		{position.index} / {position.total}
	</span>

	{#if newerHref}
		<a href={newerHref} class={iconButton} aria-label={m.photos_prev()}>
			<IconChevronLeft class="size-5" />
		</a>
	{:else}
		<span class="inline-flex size-10 items-center justify-center text-white/20" aria-hidden="true">
			<IconChevronLeft class="size-5" />
		</span>
	{/if}

	{#if olderHref}
		<a href={olderHref} class={iconButton} aria-label={m.photos_next()}>
			<IconChevronRight class="size-5" />
		</a>
	{:else}
		<span class="inline-flex size-10 items-center justify-center text-white/20" aria-hidden="true">
			<IconChevronRight class="size-5" />
		</span>
	{/if}

	<button
		type="button"
		onclick={onToggleInfo}
		class={iconButton}
		aria-label={infoOpen ? m.photos_info_close() : m.photos_info()}
		aria-pressed={infoOpen}
	>
		{#if infoOpen}
			<IconX class="size-5" />
		{:else}
			<IconInfoCircle class="size-5" />
		{/if}
	</button>
</header>

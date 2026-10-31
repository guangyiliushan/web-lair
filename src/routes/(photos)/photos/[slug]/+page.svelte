<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { photoAlt, photoText, photoTitle } from '$lib/components/photos/photo-tile';
	import PhotosViewerImage from '$lib/components/photos/photos-viewer-image.svelte';
	import PhotoInfoPanel from '$lib/components/photos/PhotoInfoPanel.svelte';
	import PhotoFilmstrip from '$lib/components/photos/PhotoFilmstrip.svelte';
	import ViewerHeader from '$lib/components/photos/ViewerHeader.svelte';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import * as Sheet from '$lib/components/ui/sheet';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let infoOpen = $state(false);
	let isDesktop = $state(false);

	onMount(() => {
		const media = window.matchMedia('(min-width: 1024px)');
		const sync = () => {
			const next = media.matches;
			if (next !== isDesktop) {
				isDesktop = next;
				infoOpen = next;
			}
		};
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});

	const tile = $derived(data.photo);
	const title = $derived(photoTitle(tile, getLocale()));
	const alt = $derived(photoAlt(tile, getLocale()));
	const description = $derived(photoText(data.photo.description, getLocale()));
	const currentIndex = $derived(data.strip.findIndex((photo) => photo.id === data.photo.id));
	const newer = $derived(currentIndex > 0 ? data.strip[currentIndex - 1] : null);
	const older = $derived(
		currentIndex >= 0 && currentIndex < data.strip.length - 1 ? data.strip[currentIndex + 1] : null
	);
	const newerHref = $derived(newer ? siteHref(`/photos/${newer.slug}`) : null);
	const olderHref = $derived(older ? siteHref(`/photos/${older.slug}`) : null);

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target;
		if (
			event.isComposing ||
			(target instanceof HTMLElement &&
				(target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
		) {
			return;
		}
		if (event.key === 'ArrowLeft' && newerHref) {
			event.preventDefault();
			void goto(newerHref);
		} else if (event.key === 'ArrowRight' && olderHref) {
			event.preventDefault();
			void goto(olderHref);
		} else if (event.key === 'i' || event.key === 'I') {
			event.preventDefault();
			infoOpen = !infoOpen;
		} else if (event.key === 'Escape') {
			if (infoOpen) infoOpen = false;
			else void goto(siteHref('/photos'));
		}
	}

	function onSwipe(event: SwipeCustomEvent) {
		if (event.detail.direction === 'left' && olderHref) void goto(olderHref);
		else if (event.detail.direction === 'right' && newerHref) void goto(newerHref);
	}

	const swipe = useSwipe(onSwipe, () => ({
		timeframe: 350,
		minSwipeDistance: 60,
		touchAction: 'pan-y'
	}));
</script>

<svelte:window onkeydown={onKeydown} />
<SeoHead path={`/photos/${data.photo.slug}`} ogTitle={title} ogDescription={description} />

<svelte:head>
	<title>{title}</title>
</svelte:head>

<ViewerHeader
	{title}
	position={data.position}
	{infoOpen}
	onToggleInfo={() => (infoOpen = !infoOpen)}
	{newerHref}
	{olderHref}
/>

<main class="h-svh">
	<h1 class="sr-only">{title}</h1>

	<div class="flex h-svh flex-col overflow-hidden bg-neutral-950 text-neutral-100">
		<div class="flex min-h-0 flex-1 pt-14">
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 items-center justify-center p-2 sm:p-4" {...swipe}>
					{#key data.photo.id}
						<PhotosViewerImage photo={data.photo} {alt} fullBleed />
					{/key}
				</div>
				<PhotoFilmstrip strip={data.strip} currentId={data.photo.id} />
			</div>

			{#if isDesktop && infoOpen}
				<aside
					class="w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-background p-4 text-foreground"
					aria-label={m.photos_info()}
				>
					<PhotoInfoPanel photo={data.photo} />
				</aside>
			{/if}
		</div>
	</div>
</main>

{#if !isDesktop}
	<Sheet.Root bind:open={infoOpen}>
		<Sheet.Content side="bottom" class="max-h-[85svh] overflow-y-auto p-0" showCloseButton={false}>
			<button
				type="button"
				onclick={() => (infoOpen = false)}
				aria-label={m.photos_info_close()}
				class="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<IconX class="size-4" />
			</button>
			<Sheet.Header class="px-4 pt-4">
				<Sheet.Title>{m.photos_info()}</Sheet.Title>
				<Sheet.Description class="truncate">{title}</Sheet.Description>
			</Sheet.Header>
			<div class="px-4 pb-6">
				<PhotoInfoPanel photo={data.photo} />
			</div>
		</Sheet.Content>
	</Sheet.Root>
{/if}

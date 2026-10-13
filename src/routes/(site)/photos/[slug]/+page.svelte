<script lang="ts">
	import { goto } from '$app/navigation';
	import { SeoHead } from '$lib/components/seo';
	import {
		photoAlt,
		photoText,
		photoTitle,
		type PhotoTile
	} from '$lib/components/photos/photo-tile';
	import PhotosViewerImage from '$lib/components/photos/photos-viewer-image.svelte';
	import PhotosViewerOverlay from '$lib/components/photos/photos-viewer-overlay.svelte';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { formatDate } from '$lib/utils/i18n';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Overlay viewer v1.1 (3c): opening it hands the page payload over; the
	 * page keyboard handler steps aside while it is open (the overlay owns
	 * the arrows then). Closing after cycling re-syncs the page. */
	let overlayOpen = $state(false);
	/** Slug the overlay was opened on: if the page payload has moved on by the
	 * time the overlay closes (same-route browser Back), the close must not
	 * navigate back and undo that navigation (review 08 F1). */
	let openedSlug: string | null = null;
	/** Set before a viewer-driven navigation; the effect below broadcasts the
	 * landed photo once the new payload renders (review 07 P2-3). */
	let announceAfterNavigation = false;
	let pageAnnouncement = $state('');

	function openOverlay() {
		openedSlug = data.photo.slug;
		overlayOpen = true;
	}

	function onFigureClick(event: MouseEvent) {
		// The stage hosts its own controls (load-full / retry): clicks there
		// keep their meaning; anything else on the stage opens the overlay.
		const target = event.target;
		if (target instanceof HTMLElement && target.closest('button, a')) return;
		openOverlay();
	}

	function handleOverlayClosed(slug: string) {
		const opened = openedSlug;
		openedSlug = null;
		if (!slug || slug === data.photo.slug) return;
		// The payload diverged from what the overlay opened on: a browser
		// Back/Forward already chose the destination - never drag it back.
		if (opened !== null && data.photo.slug !== opened) return;
		announceAfterNavigation = true;
		void goto(siteHref(`/photos/${slug}`), { replaceState: true });
	}

	// Broadcast the landed photo after a viewer-driven navigation (the overlay's
	// live region unmounts with it; Q13 "SPA focus management" needs both the
	// focus return and this announcement).
	$effect(() => {
		if (!announceAfterNavigation) return;
		announceAfterNavigation = false;
		pageAnnouncement = m.photos_viewer_announce({
			title: photoTitle(tile, getLocale()),
			index: String(data.position.index),
			total: String(data.position.total)
		});
	});

	const tile: PhotoTile = $derived(data.photo);
	const title = $derived(photoTitle(tile, getLocale()));
	const alt = $derived(photoAlt(tile, getLocale()));
	const description = $derived(photoText(data.photo.description, getLocale()));
	const dateLabel = $derived(data.photo.takenAt ? formatDate(data.photo.takenAt) : null);

	/** EXIF summary line — parts, not labels (photos are language agnostic). */
	const meta = $derived.by(() => {
		const photo = data.photo;
		const parts: string[] = [];
		if (photo.cameraMake || photo.cameraModel) {
			parts.push([photo.cameraMake, photo.cameraModel].filter(Boolean).join(' '));
		}
		if (photo.lensModel) parts.push(photo.lensModel);
		if (photo.fNumber !== null) parts.push(`f/${Number(photo.fNumber)}`);
		if (photo.focalLengthMm !== null) parts.push(`${Number(photo.focalLengthMm)}mm`);
		if (photo.exposureTimeS !== null) {
			const seconds = Number(photo.exposureTimeS);
			parts.push(seconds > 0 && seconds < 1 ? `1/${Math.round(1 / seconds)}s` : `${seconds}s`);
		}
		if (photo.iso !== null) parts.push(`ISO ${photo.iso}`);
		return parts;
	});

	// Feed order is newest first: the left arrow walks to the newer neighbour,
	// the right arrow to the older one (mirrors the source lists).
	const newerHref = $derived(
		data.neighbors.newer ? siteHref(`/photos/${data.neighbors.newer.slug}`) : null
	);
	const olderHref = $derived(
		data.neighbors.older ? siteHref(`/photos/${data.neighbors.older.slug}`) : null
	);

	function onKeydown(event: KeyboardEvent) {
		if (overlayOpen) return; // the overlay viewer owns keys while open
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		// Never hijack arrows from text entry or IME composition (round-3
		// review: a future control on this route would navigate mid-typing).
		const target = event.target;
		if (
			event.isComposing ||
			(target instanceof HTMLElement &&
				(target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
		) {
			return;
		}
		if (event.key === 'ArrowLeft' && newerHref) {
			announceAfterNavigation = true;
			void goto(newerHref);
		} else if (event.key === 'ArrowRight' && olderHref) {
			announceAfterNavigation = true;
			void goto(olderHref);
		}
	}

	function onSwipe(event: SwipeCustomEvent) {
		if (overlayOpen) return; // the overlay owns gestures while open
		if (event.detail.direction === 'left' && olderHref) {
			announceAfterNavigation = true;
			void goto(olderHref);
		} else if (event.detail.direction === 'right' && newerHref) {
			announceAfterNavigation = true;
			void goto(newerHref);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />
<SeoHead path={`/photos/${data.photo.slug}`} ogTitle={title} ogDescription={description} />

<svelte:head>
	<title>{title}</title>
</svelte:head>

<article class="mx-auto mt-8 max-w-6xl px-4 md:mt-12 lg:px-0">
	<!-- Accessible page heading (round-2 review: the viewer had no h1; the
	     visible title lives in the sticky metadata bar below). -->
	<h1 class="sr-only">{title}</h1>
	<figure
		class="flex min-h-[40vh] cursor-zoom-in items-center justify-center"
		{...useSwipe(onSwipe, () => ({ timeframe: 350, minSwipeDistance: 60, touchAction: 'pan-y' }))}
		onclick={onFigureClick}
	>
		<!-- Progressive stage (T10/T16, plan §4.5): thumb first, streamed full
		     with a 300ms-delayed progress floater; >8MB or metered → on-demand.
		     Keyed by photo id: the [slug] route is reused between neighbours
		     (previous/next), so the stage must reset per photo. -->
		{#key data.photo.id}
			<PhotosViewerImage photo={data.photo} {alt} />
		{/key}
	</figure>

	{#if description}
		<p class="mt-4 text-center text-sm text-muted-foreground">{description}</p>
	{/if}

	<div
		class="sticky bottom-4 z-10 mt-6 flex items-center gap-3 rounded-xl border bg-background/90 px-3 py-2.5 shadow-sm backdrop-blur"
	>
		<a
			class="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			href={siteHref('/photos')}
		>
			← {m.photos_back()}
		</a>
		<div class="min-w-0 flex-1 text-center">
			<p class="truncate text-sm font-medium">{title}</p>
			{#if dateLabel || meta.length > 0}
				<p class="truncate text-xs text-muted-foreground">
					{[dateLabel, ...meta].filter(Boolean).join(' · ')}
				</p>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-1">
			<button
				type="button"
				class="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={openOverlay}
			>
				{m.photos_viewer_open()}
			</button>
			{#if newerHref}
				<a
					class="rounded-md px-2.5 py-1 text-lg leading-none transition-colors hover:bg-muted"
					href={newerHref}
					aria-label={m.photos_prev()}
				>
					‹
				</a>
			{:else}
				<span class="px-2.5 py-1 text-lg leading-none text-muted-foreground/40" aria-hidden="true"
					>‹</span
				>
			{/if}
			{#if olderHref}
				<a
					class="rounded-md px-2.5 py-1 text-lg leading-none transition-colors hover:bg-muted"
					href={olderHref}
					aria-label={m.photos_next()}
				>
					›
				</a>
			{:else}
				<span class="px-2.5 py-1 text-lg leading-none text-muted-foreground/40" aria-hidden="true"
					>›</span
				>
			{/if}
		</div>
	</div>
</article>

<PhotosViewerOverlay
	bind:open={overlayOpen}
	photo={data.photo}
	neighbors={data.neighbors}
	position={data.position}
	onClosed={handleOverlayClosed}
/>

<p class="sr-only" aria-live="polite">{pageAnnouncement}</p>

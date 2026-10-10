<script lang="ts">
	import { goto } from '$app/navigation';
	import { SeoHead } from '$lib/components/seo';
	import {
		photoAlt,
		photoText,
		photoTileSrc,
		photoTitle,
		thumbhashDataUrl,
		type PhotoTile
	} from '$lib/components/photos/photo-tile';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { formatDate } from '$lib/utils/i18n';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const tile: PhotoTile = $derived(data.photo);
	const title = $derived(photoTitle(tile, getLocale()));
	const alt = $derived(photoAlt(tile, getLocale()));
	const description = $derived(photoText(data.photo.description, getLocale()));
	const dateLabel = $derived(data.photo.takenAt ? formatDate(data.photo.takenAt) : null);
	const placeholder = $derived(thumbhashDataUrl(tile.thumbhash));

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
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'ArrowLeft' && newerHref) void goto(newerHref);
		else if (event.key === 'ArrowRight' && olderHref) void goto(olderHref);
	}

	function onSwipe(event: SwipeCustomEvent) {
		if (event.detail.direction === 'left' && olderHref) void goto(olderHref);
		else if (event.detail.direction === 'right' && newerHref) void goto(newerHref);
	}
</script>

<svelte:window onkeydown={onKeydown} />
<SeoHead path={`/photos/${data.photo.slug}`} />

<article class="mx-auto mt-8 max-w-6xl px-4 md:mt-12 lg:px-0">
	<figure
		class="flex min-h-[40vh] items-center justify-center"
		{...useSwipe(onSwipe, () => ({ timeframe: 350, minSwipeDistance: 60, touchAction: 'pan-y' }))}
	>
		<img
			class="max-h-[76vh] w-auto max-w-full rounded-lg object-contain"
			src={photoTileSrc(tile, 'full')}
			{alt}
			width={tile.width ?? undefined}
			height={tile.height ?? undefined}
			style={placeholder
				? `background-image:url(${placeholder});background-size:cover;background-position:center;`
				: undefined}
			decoding="async"
		/>
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

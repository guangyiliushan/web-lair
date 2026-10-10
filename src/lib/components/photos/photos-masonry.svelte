<script lang="ts">
	import { Frame, RegularMasonryGrid } from '@masonry-grid/svelte';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { photoAlt, photoTileSrc, thumbhashDataUrl } from './photo-tile';
	import type { PhotoTile } from './photo-tile';

	/**
	 * Waterfall grid (plan §5.1; @masonry-grid/svelte Regular variant — DOM
	 * order == feed order, WCAG 2.4.3 meaningful sequence). Frames carry the
	 * real aspect ratio (zero CLS); the thumbhash placeholder paints instantly
	 * while the thumbnail streams in.
	 */
	let {
		items,
		disabled = false,
		ariaLabel = ''
	}: { items: PhotoTile[]; disabled?: boolean; ariaLabel?: string } = $props();

	const locale = $derived(getLocale());
</script>

<!-- role=group only when named: ARIA 1.2 forbids naming a role=generic div
	 (review round 1) — an unnamed wrapper keeps no role at all. -->
<div
	class="photos-masonry"
	role={ariaLabel ? 'group' : undefined}
	aria-label={ariaLabel || undefined}
>
	<RegularMasonryGrid frameWidth={240} gap={12} {disabled}>
		{#each items as tile (tile.id)}
			{@const placeholder = thumbhashDataUrl(tile.thumbhash)}
			<Frame
				width={tile.width ?? 4}
				height={tile.height ?? 3}
				class="overflow-hidden rounded-lg border bg-muted"
			>
				<a
					href={siteHref(`/photos/${tile.slug}`)}
					class="block h-full w-full"
					style={placeholder
						? `background-image:url(${placeholder});background-size:cover;background-position:center;`
						: ''}
				>
					<img
						src={photoTileSrc(tile, 'thumb')}
						alt={photoAlt(tile, locale)}
						loading="lazy"
						decoding="async"
						class="block h-full w-full object-cover"
					/>
				</a>
			</Frame>
		{/each}
	</RegularMasonryGrid>
</div>

<style>
	.photos-masonry {
		width: 100%;
	}
	.photos-masonry :global(a:focus-visible) {
		outline: 2px solid var(--accent, currentColor);
		/* Inset: the tile anchor fills a Frame with `overflow-hidden`; an
		   outside offset would be clipped and the ring invisible (review). */
		outline-offset: -2px;
	}
</style>

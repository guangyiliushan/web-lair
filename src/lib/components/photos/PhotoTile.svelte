<script lang="ts">
	import { getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { formatBytes } from '$lib/utils/format';
	import {
		photoAlt,
		photoDimensions,
		photoExifParts,
		photoTileSrc,
		photoTitle,
		thumbhashDataUrl,
		type PhotoTile
	} from './photo-tile';

	let {
		tile,
		priority = false,
		sizes = '(min-width: 1440px) 20vw, (min-width: 1200px) 25vw, (min-width: 900px) 33vw, 50vw'
	}: {
		tile: PhotoTile;
		priority?: boolean;
		sizes?: string;
	} = $props();

	const locale = $derived(getLocale());
	const title = $derived(photoTitle(tile, locale));
	const alt = $derived(photoAlt(tile, locale));
	const placeholder = $derived(thumbhashDataUrl(tile.thumbhash));
	const dimensions = $derived(photoDimensions(tile));
	const exif = $derived(photoExifParts(tile));
	const formatLabel = $derived(tile.mimeType.split('/')[1]?.toUpperCase() ?? '');
	const meta = $derived(
		[formatLabel, dimensions, typeof tile.byteSize === 'number' ? formatBytes(tile.byteSize) : null]
			.filter(Boolean)
			.join(' · ')
	);
	const src = $derived(photoTileSrc(tile, 'thumb'));
	const srcset = $derived(
		tile.mimeType === 'image/gif'
			? undefined
			: `${photoTileSrc(tile, 'thumb')} 480w, ${photoTileSrc(tile, 'grid')} 720w`
	);
</script>

<a
	href={siteHref(`/photos/${tile.slug}`)}
	aria-label={m.photos_viewer_open_alt({ alt })}
	class="group relative block h-full w-full overflow-hidden bg-muted focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none focus-visible:ring-inset"
	style={placeholder
		? `background-image:url(${placeholder});background-size:cover;background-position:center;`
		: undefined}
	data-photo-tile={tile.id}
>
	<img
		{src}
		{srcset}
		{sizes}
		{alt}
		loading={priority ? 'eager' : 'lazy'}
		fetchpriority={priority ? 'high' : 'low'}
		decoding="async"
		class="block h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
	/>

	<div
		class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent opacity-100 transition-opacity duration-200 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100"
	></div>

	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 p-2.5 text-white transition-opacity duration-200 sm:p-3 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100"
	>
		<p class="truncate text-xs font-medium sm:text-sm">{title}</p>
		{#if meta}
			<p class="mt-0.5 truncate text-[10px] text-white/70 sm:text-[11px]">{meta}</p>
		{/if}
		{#if exif.length > 0}
			<div class="mt-1.5 hidden flex-wrap gap-1 [@media(hover:hover)]:flex">
				{#each exif as part (part)}
					<span
						class="rounded-full bg-white/15 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm"
					>
						{part}
					</span>
				{/each}
			</div>
		{/if}
	</div>
</a>

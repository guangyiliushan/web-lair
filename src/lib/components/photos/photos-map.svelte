<script lang="ts">
	import { browser } from '$app/environment';
	import { MapLibre, Marker, NavigationControl, Protocol } from 'svelte-maplibre-gl';
	import { layers, namedFlavor } from '@protomaps/basemaps';
	import { Protocol as PmProtocol } from 'pmtiles';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { photoText, type MapPhoto } from './photo-tile';
	import 'maplibre-gl/dist/maplibre-gl.css';

	/**
	 * Public map (ST-2d, plan §8): the world basemap is OUR PMTiles archive in
	 * RustFS, served by `/maps/world-z0-6.pmtiles` (Range-capable route);
	 * one marker per located photo, each a real anchor so keyboard, new-tab
	 * and middle-click all behave like links.
	 */
	let { photos }: { photos: MapPhoto[] } = $props();

	const pmProtocol = new PmProtocol();
	const locale = $derived(getLocale());

	const style = {
		version: 8 as const,
		glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
		sources: {
			protomaps: {
				type: 'vector' as const,
				url: `pmtiles://${browser ? window.location.origin : ''}/maps/world-z0-6.pmtiles`,
				attribution:
					'<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · © <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
			}
		},
		layers: layers('protomaps', namedFlavor('light'), { lang: 'zh' })
	};

	const bounds = $derived.by(() => {
		if (photos.length === 0) return undefined;
		const lngs = photos.map((photo) => photo.longitude);
		const lats = photos.map((photo) => photo.latitude);
		return [
			[Math.min(...lngs), Math.min(...lats)],
			[Math.max(...lngs), Math.max(...lats)]
		] as [[number, number], [number, number]];
	});
</script>

<Protocol scheme="pmtiles" loadFn={pmProtocol.tile} />

<MapLibre
	{style}
	center={[0, 20]}
	zoom={1}
	{bounds}
	fitBoundsOptions={{ padding: 64, maxZoom: 12 }}
	class="h-[70vh] min-h-[320px] w-full overflow-hidden rounded-lg border"
	autoloadGlobalCss={false}
>
	<NavigationControl position="top-right" />
	{#each photos as photo (photo.slug)}
		<Marker lnglat={[photo.longitude, photo.latitude]}>
			{#snippet content()}
				<a
					class="photos-map-marker"
					href={siteHref(`/photos/${photo.slug}`)}
					title={photoText(photo.title, locale) ?? photo.slug}
					aria-label={photoText(photo.title, locale) ?? photo.slug}
				></a>
			{/snippet}
		</Marker>
	{/each}
</MapLibre>

<style>
	/* svelte-maplibre-gl renders marker snippets into portal content; the dot
	   keeps a 24px touch target. */
	:global(.photos-map-marker) {
		display: block;
		width: 24px;
		height: 24px;
		margin: -12px 0 0 -12px;
		border-radius: 9999px;
		background: color-mix(in oklab, var(--primary, #2563eb) 85%, transparent);
		border: 2px solid white;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
	}
	:global(.photos-map-marker:hover),
	:global(.photos-map-marker:focus-visible) {
		outline: 2px solid var(--primary, #2563eb);
		outline-offset: 2px;
	}
</style>

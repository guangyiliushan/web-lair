<script lang="ts">
	import { browser } from '$app/environment';
	import { MapLibre, Marker, NavigationControl, Protocol } from 'svelte-maplibre-gl';
	import { layers, namedFlavor } from '@protomaps/basemaps';
	import { Protocol as PmProtocol } from 'pmtiles';
	import { m } from '$lib/paraglide/messages';
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
	/** Label language follows the site locale (review round 1: hardcoded zh). */
	const mapLang = $derived(locale === 'zh-cn' ? 'zh' : locale === 'ja' ? 'ja' : 'en');
	/**
	 * Failure fallback without false positives (review round 1 follow-up):
	 * MapLibre's `error` event also fires for recoverable resource hiccups,
	 * so the copy only flips for (a) a thrown mount (the route boundary),
	 * (b) a WebGL/context-level error, or (c) a load that never completes
	 * within 12s — never for a benign warning.
	 */
	let mapFailed = $state(false);
	let mapReady = $state(false);
	let loadTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (mapReady || mapFailed || loadTimer !== null) return;
		loadTimer = setTimeout(() => {
			if (!mapReady) mapFailed = true;
		}, 12_000);
		return () => {
			if (loadTimer !== null) {
				clearTimeout(loadTimer);
				loadTimer = null;
			}
		};
	});

	function onMapError(event: unknown) {
		const error = (event as { error?: { name?: string; message?: string } } | undefined)?.error;
		const text = `${error?.name ?? ''} ${error?.message ?? ''}`;
		if (/webgl|context/i.test(text)) mapFailed = true;
	}

	const style = $derived({
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
		layers: layers('protomaps', namedFlavor('light'), { lang: mapLang })
	});

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

{#if mapFailed}
	<div class="rounded-lg border p-6 text-sm text-muted-foreground">{m.photos_map_fallback()}</div>
{:else}
	<MapLibre
		{style}
		center={[0, 20]}
		zoom={1}
		{bounds}
		fitBoundsOptions={{ padding: 64, maxZoom: 12 }}
		class="h-[70vh] min-h-[320px] w-full overflow-hidden rounded-lg border"
		autoloadGlobalCss={false}
		onload={() => {
			mapReady = true;
		}}
		onerror={onMapError}
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
{/if}

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

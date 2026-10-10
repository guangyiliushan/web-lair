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
	 *
	 * Failure handling (round-2 review): MapLibre's vector source is lazy, so
	 * a 404 archive used to mean a silently blank canvas. Now (a) a 2-byte
	 * Range probe hits the archive BEFORE mounting, (b) WebGL/context errors
	 * and a 12s never-loaded timer still flip the fallback, and (c) the
	 * fallback shows the message + the photo list + a Retry button that
	 * re-runs the probe and remounts.
	 */
	let { photos }: { photos: MapPhoto[] } = $props();

	/** One source for the archive name (probe + style); renames change here. */
	const WORLD_ARCHIVE = 'world-z0-6.pmtiles';

	const pmProtocol = new PmProtocol();
	const locale = $derived(getLocale());
	/** Label language follows the site locale (review round 1: hardcoded zh). */
	const mapLang = $derived(locale === 'zh-cn' ? 'zh' : locale === 'ja' ? 'ja' : 'en');

	let mapFailed = $state(false);
	let mapReady = $state(false);
	/** Archive probe: mount waits for `ok`; `failed` flips the fallback. */
	let probe = $state<'pending' | 'ok' | 'failed'>('pending');
	let attempt = $state(0);
	let loadTimer: ReturnType<typeof setTimeout> | null = null;

	// Probe the PMTiles archive before mounting: a 2-byte ranged GET proves
	// the route + storage answer, so a missing archive cannot render as a
	// silent blank canvas.
	$effect(() => {
		if (!browser) return;
		void attempt; // the Retry button re-arms the probe
		let cancelled = false;
		probe = 'pending';
		(async () => {
			try {
				const response = await fetch(`${window.location.origin}/maps/${WORLD_ARCHIVE}`, {
					headers: { Range: 'bytes=0-1' }
				});
				if (!cancelled) probe = response.ok ? 'ok' : 'failed';
			} catch {
				if (!cancelled) probe = 'failed';
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (probe === 'failed') mapFailed = true;
	});

	$effect(() => {
		if (mapReady || mapFailed || probe !== 'ok' || loadTimer !== null) return;
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

	function retry() {
		mapFailed = false;
		mapReady = false;
		probe = 'pending';
		attempt += 1;
	}

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
				url: `pmtiles://${browser ? window.location.origin : ''}/maps/${WORLD_ARCHIVE}`,
				attribution:
					'<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · © <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
			}
		},
		layers: layers('protomaps', namedFlavor('light'), { lang: mapLang })
	});

	// `bounds` needs ≥2 points; a single photo gets an explicit center+zoom
	// (round-2 review: a degenerate bounds box relied on maxZoom clamping).
	// Antimeridian-crossing bounds remain registered as a known limit.
	const single = $derived(photos.length === 1 ? photos[0]! : null);
	const bounds = $derived.by(() => {
		if (photos.length < 2) return undefined;
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
	<div class="rounded-lg border p-6 text-sm text-muted-foreground">
		<p>{m.photos_map_fallback()}</p>
		<ul class="mt-4 space-y-1.5">
			{#each photos as photo (photo.slug)}
				<li class="truncate">
					<a
						class="underline underline-offset-2 hover:text-foreground"
						href={siteHref(`/photos/${photo.slug}`)}
					>
						{photoText(photo.title, locale) ?? photo.slug}
					</a>
				</li>
			{/each}
		</ul>
		<button
			type="button"
			class="mt-4 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
			onclick={retry}
		>
			{m.photos_map_retry()}
		</button>
	</div>
{:else if probe === 'ok'}
	<MapLibre
		{style}
		center={single ? [single.longitude, single.latitude] : [0, 20]}
		zoom={single ? 10 : 1}
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
{:else}
	<!-- Same footprint while the probe runs: no layout jump on success. -->
	<div class="h-[70vh] min-h-[320px] w-full rounded-lg border" aria-hidden="true"></div>
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

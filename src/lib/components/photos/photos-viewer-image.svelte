<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import { photoTileSrc, thumbhashDataUrl } from './photo-tile';
	import { formatBytes } from '$lib/utils/format';
	import {
		FLOATER_DELAY_MS,
		shouldLoadFullOnDemand,
		type ConnectionLike,
		type ViewerImageSource
	} from './viewer-load';

	/**
	 * Progressive full-image stage for the page viewer (plan §4.5, T10/T16 —
	 * the overlay viewer keeps its own copy for v1.1).
	 *
	 * - Policy: ≤8MB and no metered signal → auto-load; over threshold or
	 *   saveData/2G → an explicit "load full image" button.
	 * - Measurement: fetch + ReadableStream accumulation against
	 *   Content-Length (both pass through /i); the floater only appears when
	 *   the load outlives 300ms, so cache hits never flash a spinner.
	 * - Terminal states only reach the live region (`aria-live="polite"` —
	 *   W3C 4.1.3 status messages); the ring/copy updates stay visual.
	 * - `prefers-reduced-motion` drops the fade; a failed load keeps the card
	 *   visible with a Retry.
	 */
	let { photo, alt }: { photo: ViewerImageSource; alt: string } = $props();

	// $derived, not consts: the detail route reuses this component between
	// photos (next/prev); the page wraps it in `{#key photo.id}` so a photo
	// change remounts the stage — these reads stay reactive for safety.
	const fullSrc = $derived(photoTileSrc(photo, 'full'));
	const thumbSrc = $derived(photoTileSrc(photo, 'thumb'));
	const placeholder = $derived(thumbhashDataUrl(photo.thumbhash));

	// Progressive enhancement only (MDN: limited availability; Safari/Firefox
	// never shipped it) — absence = the threshold path decides.
	const connection: ConnectionLike | null = browser
		? ((navigator as Navigator & { connection?: ConnectionLike }).connection ?? null)
		: null;
	const onDemand = $derived(shouldLoadFullOnDemand(photo.byteSize, connection));

	// GIFs have no variant tiers: photoTileSrc returns the ORIGINAL for every
	// tier, so rendering the interim image would download the whole file even
	// under an on-demand decision (round-2 confirm, P2). On-demand GIFs hold
	// the layout box instead and load on the explicit click. SSR cannot see
	// `navigator.connection`, so GIFs render NO <img> until mount — otherwise
	// a metered client would preload the original before hydration and the
	// two sides would disagree on the element type (round-3 review, P2).
	/** Flips after hydration; GIF interim images wait for it (SSR-true). */
	let mounted = $state(false);
	const isGif = $derived(photo.mimeType === 'image/gif');
	const interimSrc = $derived(isGif && (!mounted || onDemand) ? null : thumbSrc);

	type Phase = 'waiting' | 'loading' | 'done' | 'error';
	// SSR renders the loading phase for BOTH branches (the connection signal
	// only exists client-side); onMount flips to `waiting` when on-demand,
	// which keeps hydration output identical and avoids a mismatch.
	let phase = $state<Phase>('loading');
	let objectUrl = $state<string | null>(null);
	let loadedBytes = $state(0);
	let totalBytes = $state<number | null>(null);
	let cardVisible = $state(false);
	let cardHiding = $state(false);
	let announcement = $state('');
	let controller: AbortController | null = null;
	let floaterTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	/** In-flight latch: `phase` doubles as UI state, never as a reentry guard
	 * (the SSR-consistent initial phase IS 'loading'). */
	let loading = false;

	const fraction = $derived(
		totalBytes !== null && totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : null
	);
	const percent = $derived(fraction === null ? 0 : Math.round(fraction * 100));

	async function loadFull(): Promise<void> {
		if (loading || phase === 'done') return;
		loading = true;
		phase = 'loading';
		loadedBytes = 0;
		totalBytes = typeof photo.byteSize === 'number' ? photo.byteSize : null;
		announcement = '';
		cardHiding = false;
		if (hideTimer !== null) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		if (floaterTimer !== null) clearTimeout(floaterTimer);
		floaterTimer = setTimeout(() => {
			if (phase === 'loading') cardVisible = true;
		}, FLOATER_DELAY_MS);
		const ctl = new AbortController();
		controller = ctl;
		try {
			const response = await fetch(fullSrc, { signal: ctl.signal });
			if (!response.ok) throw new Error(`full image ${response.status}`);
			const length = Number(response.headers.get('content-length'));
			if (Number.isFinite(length) && length > 0) totalBytes = length;
			let blob: Blob;
			const reader = response.body?.getReader();
			if (reader) {
				const chunks: BlobPart[] = [];
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					// Zero-copy: the reader hands Uint8Array views whose buffer
					// type TS cannot prove is a plain ArrayBuffer (BlobPart
					// wants one); the bytes are identical at runtime.
					chunks.push(value as unknown as BlobPart);
					loadedBytes += value.byteLength;
				}
				blob = new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
			} else {
				blob = await response.blob();
				loadedBytes = blob.size;
			}
			if (ctl.signal.aborted) return;
			if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
			objectUrl = URL.createObjectURL(blob);
			phase = 'done';
			announcement = m.photos_viewer_loaded();
			fadeCardOut();
		} catch {
			if (ctl.signal.aborted) return;
			phase = 'error';
			cardVisible = true; // failure is terminal here: keep retry visible
			announcement = m.photos_viewer_load_failed();
		} finally {
			loading = false;
		}
	}

	function fadeCardOut(): void {
		if (floaterTimer !== null) {
			clearTimeout(floaterTimer);
			floaterTimer = null;
		}
		if (!cardVisible) return;
		cardHiding = true;
		hideTimer = setTimeout(() => {
			cardVisible = false;
			cardHiding = false;
		}, 350);
	}

	onMount(() => {
		mounted = true;
		if (onDemand) {
			phase = 'waiting';
			return;
		}
		void loadFull();
	});

	onDestroy(() => {
		controller?.abort();
		if (floaterTimer !== null) clearTimeout(floaterTimer);
		if (hideTimer !== null) clearTimeout(hideTimer);
		if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
	});

	const RING_RADIUS = 15.5;
	const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
</script>

{#if objectUrl || interimSrc}
	<img
		class="photos-viewer-image max-h-[76vh] w-auto max-w-full rounded-lg object-contain"
		src={objectUrl ?? interimSrc}
		{alt}
		width={photo.width ?? undefined}
		height={photo.height ?? undefined}
		style={!objectUrl && placeholder
			? `background-image:url(${placeholder});background-size:cover;background-position:center;`
			: undefined}
		decoding="async"
		data-phase={phase}
	/>
{:else}
	<!-- On-demand GIF: no tier exists to show before the click; hold the
	     layout box so the floater and controls do not jump. -->
	<div
		class="photos-viewer-image max-h-[76vh] w-full max-w-full rounded-lg bg-muted/40"
		style={photo.width && photo.height
			? `aspect-ratio:${photo.width}/${photo.height};`
			: 'min-height:40vh;'}
		aria-hidden="true"
		data-phase={phase}
	></div>
{/if}

{#if phase === 'waiting'}
	<div class="fixed right-4 bottom-4 z-30">
		<button
			type="button"
			class="photos-viewer-load rounded-xl border bg-background/90 px-4 py-2.5 text-sm shadow-sm backdrop-blur transition-colors hover:bg-muted"
			onclick={() => void loadFull()}
		>
			{m.photos_viewer_load_full({
				size: photo.byteSize !== null ? formatBytes(photo.byteSize) : '—'
			})}
		</button>
	</div>
{:else if cardVisible}
	<div
		class="photos-viewer-progress fixed right-4 bottom-4 z-30 flex items-center gap-3 rounded-xl border bg-background/90 px-3 py-2.5 text-sm shadow-sm backdrop-blur transition-opacity duration-300 motion-reduce:transition-none"
		class:opacity-0={cardHiding}
	>
		{#if phase === 'loading'}
			{#if fraction !== null}
				<svg viewBox="0 0 36 36" class="size-9 shrink-0 -rotate-90" aria-hidden="true">
					<circle
						cx="18"
						cy="18"
						r={RING_RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="3"
						class="text-muted-foreground opacity-25"
					/>
					<circle
						cx="18"
						cy="18"
						r={RING_RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="3"
						stroke-linecap="round"
						class="text-primary"
						stroke-dasharray={String(RING_CIRCUMFERENCE)}
						stroke-dashoffset={String(RING_CIRCUMFERENCE * (1 - fraction))}
					/>
				</svg>
				<span class="whitespace-nowrap">
					{m.photos_viewer_loading_detail({
						loaded: formatBytes(loadedBytes),
						total: formatBytes(totalBytes ?? loadedBytes),
						percent: String(percent)
					})}
				</span>
			{:else}
				<svg
					class="size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
				>
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
					></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
					></path>
				</svg>
				<span class="whitespace-nowrap">{m.photos_viewer_loading()}</span>
			{/if}
		{:else if phase === 'done'}
			<!-- The completed state stays visible while the card fades out
			     (round-2 confirm P3: the fade used to animate an empty pill). -->
			<span class="whitespace-nowrap">{m.photos_viewer_loaded()}</span>
		{:else if phase === 'error'}
			<span class="whitespace-nowrap">{m.photos_viewer_load_failed()}</span>
			<button
				type="button"
				class="photos-viewer-retry rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
				onclick={() => void loadFull()}
			>
				{m.photos_viewer_retry()}
			</button>
		{/if}
	</div>
{/if}

<p class="sr-only" aria-live="polite">{announcement}</p>

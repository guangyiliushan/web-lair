<script lang="ts">
	import { replaceState } from '$app/navigation';
	import * as Dialog from '$lib/components/ui/dialog';
	import { onDestroy, untrack } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { formatBytes } from '$lib/utils/format';
	import { siteHref } from '$lib/utils/href';
	import { SvelteSet } from 'svelte/reactivity';
	import { usePan, usePinch, type PanCustomEvent, type PinchCustomEvent } from 'svelte-gestures';
	import {
		EMBED_PREVIEW_LONG_EDGE,
		photoAlt,
		photoTileSrc,
		photoTitle,
		thumbhashDataUrl,
		type PhotoViewerSource
	} from './photo-tile';
	import {
		FLOATER_DELAY_MS,
		shouldLoadFullOnDemand,
		streamImageBytes,
		type ConnectionLike
	} from './viewer-load';
	import {
		identity,
		isZoomed,
		keyZoom,
		panBy,
		reset,
		shouldCloseOnSwipe,
		toggleDoubleClick,
		wheelZoom,
		zoomAt,
		type Size,
		type ViewerTransform
	} from './viewer-transform';

	/**
	 * Overlay viewer v1.1 (plan §5.3; Q13 table). Shell = bits-ui Dialog (focus
	 * trap / Esc / scroll lock / focus return - all official defaults); layer 2
	 * = `viewer-transform` (pure); this component owns the DOM and the state
	 * that must live per instance (Q5: policy helpers are shared, DOM/state are
	 * not). Cycling: ±1 neighbours arrive with the SSR payload; past that
	 * window the component fetches `/api/photo-neighbors` and shallow-syncs the
	 * URL (kit `replaceState`, raw history before the router starts; Q13). The
	 * parent decides what closing does with a navigated URL (`onClosed`).
	 */
	interface Props {
		open: boolean;
		photo: PhotoViewerSource;
		neighbors: { newer: PhotoViewerSource | null; older: PhotoViewerSource | null };
		position: { index: number; total: number };
		/** Fired once per close with the (possibly navigated) slug. */
		onClosed?: (slug: string) => void;
	}

	let { open = $bindable(false), photo, neighbors, position, onClosed }: Props = $props();

	// Initial captures only; `initialize()` re-syncs them from the props on
	// every open, so `untrack` documents the intent (and silences
	// state_referenced_locally).
	let current = $state(untrack(() => photo));
	let currentNeighbors = $state(untrack(() => neighbors));
	let currentPosition = $state(untrack(() => position));
	let transform = $state<ViewerTransform>(identity());
	/** Smooth transitions for programmatic zooms; drags/pinches stay instant. */
	let smooth = $state(false);

	let stageEl = $state<HTMLDivElement | null>(null);
	let imageEl = $state<HTMLImageElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);

	const connection: ConnectionLike | null =
		typeof navigator === 'undefined'
			? null
			: ((navigator as Navigator & { connection?: ConnectionLike }).connection ?? null);

	// ── Loading (per photo; shared policy, instance DOM - Q5) ──
	type Phase = 'loading' | 'ready' | 'error' | 'waiting';
	let phase = $state<Phase>('loading');
	let objectUrl = $state<string | null>(null);
	let loadedBytes = $state(0);
	let totalBytes = $state<number | null>(null);
	let cardVisible = $state(false);
	let cardHiding = $state(false);
	let announcement = $state('');
	let controller: AbortController | null = null;
	let loadToken = 0;
	let floaterTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let announceTimer: ReturnType<typeof setTimeout> | null = null;

	const onDemand = $derived(shouldLoadFullOnDemand(current.byteSize, connection));
	const isGif = $derived(current.mimeType === 'image/gif');
	// GIFs have no tier to show before the click (photoTileSrc returns the
	// original for every tier), so they hold the layout box until ready.
	const interimSrc = $derived(isGif ? null : photoTileSrc(current, 'thumb'));
	const placeholder = $derived(thumbhashDataUrl(current.thumbhash));
	const displaySrc = $derived(objectUrl ?? interimSrc);
	const alt = $derived(photoAlt(current, getLocale()));
	const title = $derived(photoTitle(current, getLocale()));
	const fraction = $derived(
		totalBytes !== null && totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : null
	);
	const percent = $derived(fraction === null ? 0 : Math.round(fraction * 100));
	const transformStyle = $derived(
		`transform: translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale});`
	);

	// ── Open/close lifecycle ──
	let wasOpen = false;
	$effect(() => {
		if (open === wasOpen) return;
		wasOpen = open;
		if (open) {
			initialize();
		} else {
			// Every close path (button / Esc / backdrop / swipe) lands here;
			// bits-ui does not call onOpenChange for programmatic closes, so
			// this transition is the single source for the parent callback.
			teardown();
			onClosed?.(current.slug);
		}
	});

	// Unmount while open (e.g. a browser Back): clean up, never re-enter the
	// parent's close handling - the page is already navigating away.
	onDestroy(teardown);

	function initialize() {
		current = photo;
		currentNeighbors = neighbors;
		currentPosition = position;
		transform = identity();
		smooth = false;
		announcement = '';
		historySync(photo.slug);
		scheduleAnnounce();
		prefetchAround();
		void startLoad();
	}

	function teardown() {
		loadToken += 1;
		controller?.abort();
		controller = null;
		clearTimers();
		cardVisible = false;
		cardHiding = false;
		announcement = '';
		if (objectUrl !== null) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
	}

	function clearTimers() {
		if (floaterTimer) clearTimeout(floaterTimer);
		if (hideTimer) clearTimeout(hideTimer);
		if (announceTimer) clearTimeout(announceTimer);
		floaterTimer = null;
		hideTimer = null;
		announceTimer = null;
	}

	async function startLoad(force = false): Promise<void> {
		if (!force && onDemand) {
			phase = 'waiting';
			return;
		}
		const token = ++loadToken;
		controller?.abort();
		const ctl = new AbortController();
		controller = ctl;
		phase = 'loading';
		loadedBytes = 0;
		totalBytes = typeof current.byteSize === 'number' ? current.byteSize : null;
		announcement = '';
		cardHiding = false;
		if (floaterTimer) clearTimeout(floaterTimer);
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		floaterTimer = setTimeout(() => {
			if (phase === 'loading') cardVisible = true;
		}, FLOATER_DELAY_MS);
		try {
			const blob = await streamImageBytes(photoTileSrc(current, 'full'), {
				signal: ctl.signal,
				fallbackTotal: totalBytes,
				onProgress: (progress) => {
					loadedBytes = progress.loaded;
					if (progress.total !== null) totalBytes = progress.total;
				}
			});
			if (ctl.signal.aborted || token !== loadToken) return;
			if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
			objectUrl = URL.createObjectURL(blob);
			phase = 'ready';
			announcement = m.photos_viewer_loaded();
			fadeCardOut();
		} catch {
			if (ctl.signal.aborted || token !== loadToken) return;
			phase = 'error';
			cardVisible = true; // failure is terminal: keep retry visible
			announcement = m.photos_viewer_load_failed();
		}
	}

	function fadeCardOut(): void {
		if (floaterTimer) {
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

	// ── Navigation (Q13: ←→ neighbours; URL via history.replaceState) ──
	let navToken = 0;
	async function navigate(direction: 'newer' | 'older'): Promise<void> {
		const target = direction === 'newer' ? currentNeighbors.newer : currentNeighbors.older;
		if (!target) return;
		const previous = current;
		const token = ++navToken;
		current = target;
		// Provisional window: the photo we came from is on the opposite side;
		// the fetch below fills the rest (rapid arrows can walk the chain).
		currentNeighbors =
			direction === 'newer' ? { newer: null, older: previous } : { newer: previous, older: null };
		const delta = direction === 'newer' ? -1 : 1;
		currentPosition = {
			index: Math.min(
				Math.max(currentPosition.index + delta, 1),
				Math.max(currentPosition.total, 1)
			),
			total: currentPosition.total
		};
		transform = identity();
		smooth = false;
		if (objectUrl !== null) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
		historySync(target.slug);
		scheduleAnnounce();
		void startLoad();
		void extendWindow(target.slug, token);
	}

	async function extendWindow(slug: string, token: number): Promise<void> {
		try {
			const response = await fetch(`/api/photo-neighbors?slug=${encodeURIComponent(slug)}`);
			if (!response.ok) return;
			const payload = (await response.json()) as {
				photo?: { slug?: string };
				newer?: PhotoViewerSource | null;
				older?: PhotoViewerSource | null;
				position?: { index: number; total: number };
			};
			if (token !== navToken || payload.photo?.slug !== slug) return;
			currentNeighbors = { newer: payload.newer ?? null, older: payload.older ?? null };
			if (payload.position) currentPosition = payload.position;
		} catch {
			// Offline: the provisional window still allows backtracking.
		}
	}

	function historySync(slug: string): void {
		const href = siteHref(`/photos/${slug}`);
		try {
			// Kit's shallow replace keeps the router snapshot in sync. It throws
			// when the router has not started (isolated mounts / cold boot), so
			// fall back to the raw history API there — never before hydration.
			replaceState(href, {});
		} catch {
			if (typeof history !== 'undefined') history.replaceState(history.state, '', href);
		}
	}

	// ── Prefetch ±1 (Q13: thumb + preview only) ──
	const prefetched = new SvelteSet<string>();
	function preloadOnce(src: string): void {
		if (prefetched.has(src)) return;
		prefetched.add(src);
		const image = new Image();
		image.src = src;
	}

	function prefetchAround(): void {
		for (const item of [currentNeighbors.newer, currentNeighbors.older]) {
			if (!item) continue;
			preloadOnce(photoTileSrc(item, 'thumb'));
			// The preview tier exists only above the preview box (GIFs: never).
			const longEdge = Math.max(item.width ?? 0, item.height ?? 0);
			if (item.mimeType !== 'image/gif' && longEdge > EMBED_PREVIEW_LONG_EDGE) {
				preloadOnce(photoTileSrc(item, 'preview'));
			}
		}
	}

	$effect(() => {
		if (!open) return;
		prefetchAround();
	});

	// ── Announcements (terminal load states + settled position, W3C 4.1.3) ──
	function scheduleAnnounce(): void {
		if (announceTimer) clearTimeout(announceTimer);
		announceTimer = setTimeout(() => {
			if (!open) return;
			announcement = m.photos_viewer_announce({
				title: photoTitle(current, getLocale()),
				index: String(currentPosition.index),
				total: String(currentPosition.total)
			});
		}, 450);
	}

	// ── Geometry helpers (centre-frame pointer coords for the transform SM) ──
	function viewportSize(): Size {
		return stageEl
			? { width: stageEl.clientWidth, height: stageEl.clientHeight }
			: { width: 0, height: 0 };
	}

	function contentSize(): Size {
		return imageEl
			? { width: imageEl.offsetWidth, height: imageEl.offsetHeight }
			: { width: 0, height: 0 };
	}

	function centerCoords(clientX: number, clientY: number): { x: number; y: number } {
		const rect = stageEl?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
	}

	// ── Desktop interactions ──
	function wheelListener(node: HTMLElement) {
		const handler = (event: WheelEvent) => {
			event.preventDefault();
			smooth = true;
			transform = wheelZoom(
				transform,
				event.deltaY,
				centerCoords(event.clientX, event.clientY),
				viewportSize(),
				contentSize()
			);
		};
		node.addEventListener('wheel', handler, { passive: false });
		return { destroy: () => node.removeEventListener('wheel', handler) };
	}

	function onStageDoubleClick(event: MouseEvent): void {
		smooth = true;
		transform = toggleDoubleClick(
			transform,
			centerCoords(event.clientX, event.clientY),
			viewportSize(),
			contentSize()
		);
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (!open) return;
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			event.isComposing
		) {
			return;
		}
		const key = event.key;
		if (key === '+' || key === '=') {
			smooth = true;
			transform = keyZoom(transform, 1, viewportSize(), contentSize());
		} else if (key === '-' || key === '_') {
			smooth = true;
			transform = keyZoom(transform, -1, viewportSize(), contentSize());
		} else if (key === '0') {
			smooth = true;
			transform = reset();
		} else if (key === 'ArrowLeft') {
			void navigate('newer');
		} else if (key === 'ArrowRight') {
			void navigate('older');
		} else {
			return;
		}
		event.preventDefault();
	}

	// ── Touch/pointer gestures (unzoomed: swipe = navigate / down-close; zoomed: pan) ──
	let panStart: { x: number; y: number } | null = null;
	let panLast: { x: number; y: number } | null = null;
	let panMoved = false;

	function onPan(event: PanCustomEvent): void {
		const { x, y } = event.detail;
		if (!panStart) {
			panStart = { x, y };
			panLast = { x, y };
			return;
		}
		const dx = x - (panLast?.x ?? x);
		const dy = y - (panLast?.y ?? y);
		panLast = { x, y };
		if (Math.abs(x - panStart.x) + Math.abs(y - panStart.y) > 6) panMoved = true;
		if (isZoomed(transform)) {
			smooth = false;
			transform = panBy(transform, dx, dy, viewportSize(), contentSize());
		}
	}

	function onPanDown(): void {
		panStart = null;
		panLast = null;
		panMoved = false;
	}

	function onPanUp(): void {
		if (panStart && panLast && !isZoomed(transform)) {
			const dx = panLast.x - panStart.x;
			const dy = panLast.y - panStart.y;
			if (Math.abs(dy) >= Math.abs(dx)) {
				if (shouldCloseOnSwipe(transform, dy)) open = false;
			} else if (Math.abs(dx) > 60) {
				void navigate(dx < 0 ? 'older' : 'newer');
			}
		}
		panStart = null;
		panLast = null;
		// The synthetic click that follows a drag fires before this timer: it
		// is suppressed by panMoved, while the next clean tap may close.
		setTimeout(() => {
			panMoved = false;
		}, 0);
	}

	let pinchBase: ViewerTransform | null = null;
	function onPinch(event: PinchCustomEvent): void {
		const { scale, center } = event.detail;
		if (!pinchBase) pinchBase = transform;
		smooth = false;
		transform = zoomAt(
			pinchBase,
			scale,
			centerCoords(center.x, center.y),
			viewportSize(),
			contentSize()
		);
	}

	function onPinchDown(): void {
		pinchBase = null;
	}

	// ── Backdrop click close (Q13: Esc / background / close button) ──
	function onStageClick(event: MouseEvent): void {
		if (event.target !== stageEl) return; // clicks on the image do not close
		if (panMoved) return; // the click that ends a drag is not a backdrop tap
		if (isZoomed(transform)) return; // zoomed: the backdrop pans, it does not close
		open = false;
	}

	function handleOpenAutoFocus(event: Event): void {
		// Focus the close button instead of the content box: predictable exit,
		// and bits-ui still restores focus to the trigger on close (Q13/T11).
		event.preventDefault();
		closeButton?.focus();
	}

	const RING_RADIUS = 15.5;
	const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
</script>

<svelte:window onkeydown={onWindowKeydown} />

<Dialog.Root bind:open>
	<Dialog.Content
		showCloseButton={false}
		class="fixed inset-0 top-0 left-0 z-50 h-full w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none ring-0 outline-none sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<Dialog.Title class="sr-only">{title}</Dialog.Title>
		<Dialog.Description class="sr-only">{alt}</Dialog.Description>
		<div class="absolute inset-0 bg-black/[0.92]" aria-hidden="true"></div>

		<div
			bind:this={stageEl}
			data-photos-viewer-stage
			class="absolute inset-0 flex touch-none items-center justify-center overflow-hidden"
			use:wheelListener
			{...usePan(onPan, () => ({ touchAction: 'none' }), {
				onpandown: onPanDown,
				onpanup: onPanUp
			})}
			{...usePinch(onPinch, () => ({ touchAction: 'none' }), { onpinchdown: onPinchDown })}
			onclick={onStageClick}
			ondblclick={onStageDoubleClick}
		>
			{#if displaySrc}
				<img
					bind:this={imageEl}
					class="max-h-full max-w-full rounded-lg object-contain select-none {smooth
						? 'transition-transform duration-150 ease-out motion-reduce:transition-none'
						: ''}"
					src={displaySrc}
					{alt}
					draggable="false"
					width={current.width ?? undefined}
					height={current.height ?? undefined}
					style="{transformStyle}{!objectUrl && placeholder
						? `background-image:url(${placeholder});background-size:cover;background-position:center;`
						: ''}"
					decoding="async"
					data-phase={phase}
				/>
			{:else}
				<!-- On-demand GIF: no tier exists before the click; hold the box. -->
				<div
					class="max-h-full w-full max-w-full rounded-lg bg-muted/40"
					style={current.width && current.height
						? `aspect-ratio:${current.width}/${current.height};${transformStyle}`
						: `min-height:40vh;${transformStyle}`}
					aria-hidden="true"
					data-phase={phase}
				></div>
			{/if}
		</div>

		<!-- Counter (top centre) + close (top right) -->
		<p
			data-photos-viewer-counter
			class="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 font-mono text-xs text-white/90"
		>
			{currentPosition.index} / {currentPosition.total}
		</p>
		<button
			bind:this={closeButton}
			type="button"
			class="absolute top-3 right-3 z-20 flex size-10 items-center justify-center rounded-full bg-black/50 text-xl leading-none text-white transition-colors hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
			aria-label={m.photos_viewer_close()}
			onclick={() => (open = false)}
		>
			<svg
				viewBox="0 0 24 24"
				class="size-5"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
			</svg>
		</button>

		<!-- Bottom bar: prev / caption (= alt, Q13) / next -->
		<div
			class="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pt-10 pb-3"
		>
			<button
				type="button"
				class="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white transition-colors hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-30 disabled:hover:bg-black/50"
				aria-label={m.photos_prev()}
				disabled={!currentNeighbors.newer}
				onclick={() => void navigate('newer')}
			>
				<span aria-hidden="true">‹</span>
			</button>
			<p
				data-photos-viewer-caption
				class="min-w-0 flex-1 truncate text-center text-sm text-white/90"
			>
				{alt}
			</p>
			<button
				type="button"
				class="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white transition-colors hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-30 disabled:hover:bg-black/50"
				aria-label={m.photos_next()}
				disabled={!currentNeighbors.older}
				onclick={() => void navigate('older')}
			>
				<span aria-hidden="true">›</span>
			</button>
		</div>

		<!-- Loading floater / on-demand button (own DOM; shared policy) -->
		{#if phase === 'waiting'}
			<div class="absolute right-4 bottom-20 z-30">
				<button
					type="button"
					class="rounded-xl border border-white/20 bg-black/60 px-4 py-2.5 text-sm text-white backdrop-blur transition-colors hover:bg-black/80"
					onclick={() => void startLoad(true)}
				>
					{m.photos_viewer_load_full({
						size: current.byteSize !== null ? formatBytes(current.byteSize) : '—'
					})}
				</button>
			</div>
		{:else if cardVisible}
			<div
				class="photos-viewer-progress absolute right-4 bottom-20 z-30 flex items-center gap-3 rounded-xl border border-white/20 bg-black/60 px-3 py-2.5 text-sm text-white backdrop-blur transition-opacity duration-300 motion-reduce:transition-none"
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
								class="opacity-25"
							/>
							<circle
								cx="18"
								cy="18"
								r={RING_RADIUS}
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								stroke-linecap="round"
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
						<span class="whitespace-nowrap">{m.photos_viewer_loading()}</span>
					{/if}
				{:else if phase === 'ready'}
					<span class="whitespace-nowrap">{m.photos_viewer_loaded()}</span>
				{:else if phase === 'error'}
					<span class="whitespace-nowrap">{m.photos_viewer_load_failed()}</span>
					<button
						type="button"
						class="rounded-md border border-white/30 px-3 py-1.5 text-sm transition-colors hover:bg-white/10"
						onclick={() => void startLoad(true)}
					>
						{m.photos_viewer_retry()}
					</button>
				{/if}
			</div>
		{/if}

		<p class="sr-only" aria-live="polite">{announcement}</p>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts">
	import { replaceState } from '$app/navigation';
	import * as Dialog from '$lib/components/ui/dialog';
	import { onDestroy, untrack } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { formatBytes } from '$lib/utils/format';
	import { siteHref } from '$lib/utils/href';
	import { isPhotoSlug } from '$lib/utils/slug';
	import { IconX } from '@tabler/icons-svelte-runes';
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
	import { plainLabel, type PlainImageSource } from './viewer-source';
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
	 *
	 * Source adaptation (3d): the same shell serves the article lightbox via
	 * `plain` - a single content image with no neighbours, no counter and no
	 * URL sync (the feed-only machinery simply sees `current === null`).
	 */
	interface Props {
		open: boolean;
		/** Photo-feed mode inputs (page viewer); ignored when `plain` is set. */
		photo?: PhotoViewerSource | null;
		neighbors?: { newer: PhotoViewerSource | null; older: PhotoViewerSource | null };
		position?: { index: number; total: number };
		/**
		 * Single-image content mode (3d article lightbox). The two modes are
		 * mutually exclusive: each host supplies exactly one of `photo` /
		 * `plain` (feeding `neighbors`/`position` only with the former).
		 */
		plain?: PlainImageSource | null;
		/** Fired once per close with the (possibly navigated) slug ('' in plain). */
		onClosed?: (slug: string) => void;
	}

	let {
		open = $bindable(false),
		photo = null,
		neighbors = { newer: null, older: null },
		position = { index: 1, total: 1 },
		plain = null,
		onClosed
	}: Props = $props();

	// Initial captures only; `initialize()` re-syncs them from the props on
	// every open, so `untrack` documents the intent (and silences
	// state_referenced_locally).
	let current = $state<PhotoViewerSource | null>(untrack(() => photo));
	let plainItem = $state<PlainImageSource | null>(untrack(() => plain));
	let currentNeighbors = $state(untrack(() => neighbors));
	let currentPosition = $state(untrack(() => position));
	let transform = $state<ViewerTransform>(identity());
	/** Smooth transitions for programmatic zooms; drags/pinches stay instant. */
	let smooth = $state(false);

	let stageEl = $state<HTMLDivElement | null>(null);
	let imageEl = $state<HTMLImageElement | null>(null);
	let closeButton = $state<HTMLElement | null>(null);
	/** The src that failed to load: clicks on a broken image pass through to
	 * the stage so the backdrop still closes (review 08: the broken img
	 * otherwise balloons over the whole stage and eats the tap). Keyed by src -
	 * resetting on unrelated state changes once un-broke a still-broken image. */
	let brokenSrc = $state<string | null>(null);
	/** The photo the overlay opened on; the page payload diverging from it while
	 * open means a browser Back/Forward re-loaded the route underneath. */
	let openedSnapshotId: string | null = null;
	/** Set by closeSilently(): skip the parent onClosed (no re-sync navigation). */
	let suppressClosed = false;

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

	// ── Per-item dispatchers (source adaptation; 3d) ──
	function byteSizeOf(): number | null {
		return plainItem ? null : (current?.byteSize ?? null);
	}
	function byteSizeLabel(): string {
		const size = byteSizeOf();
		return size !== null ? formatBytes(size) : '—';
	}
	function interimOf(): string | null {
		if (plainItem) return plainItem.src;
		if (!current) return null;
		// GIFs have no tier to show before the click (photoTileSrc returns the
		// original for every tier), so they hold the layout box until ready.
		return current.mimeType === 'image/gif' ? null : photoTileSrc(current, 'thumb');
	}
	function fullOf(): string | null {
		if (plainItem) return plainItem.fullSrc;
		return current ? photoTileSrc(current, 'full') : null;
	}
	function widthOf(): number | null {
		return plainItem ? plainItem.width : (current?.width ?? null);
	}
	function heightOf(): number | null {
		return plainItem ? plainItem.height : (current?.height ?? null);
	}
	function labelOf(): string {
		if (plainItem) return plainLabel(plainItem);
		return current ? photoAlt(current, getLocale()) : '';
	}
	function titleOf(): string {
		if (plainItem) return plainLabel(plainItem);
		return current ? photoTitle(current, getLocale()) : '';
	}

	// `byteSizeOf()` is null for plain items, so one call covers both modes
	// (review 3d: the previous ternary was per-case identical).
	const onDemand = $derived(shouldLoadFullOnDemand(byteSizeOf(), connection));
	const interimSrc = $derived(interimOf());
	const placeholder = $derived(thumbhashDataUrl(plainItem ? null : (current?.thumbhash ?? null)));
	const displaySrc = $derived(objectUrl ?? interimSrc);
	const alt = $derived(labelOf());
	const title = $derived(titleOf());
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
			// this transition is the single source for the parent callback -
			// except closeSilently(): the page already navigated itself and
			// must not be dragged back by a close-time re-sync.
			teardown();
			if (suppressClosed) {
				suppressClosed = false;
			} else {
				onClosed?.(current?.slug ?? '');
			}
		}
	});

	// The page can re-load underneath an open overlay (browser Back/Forward
	// on the same route re-runs the load without remounting this component):
	// the walked position no longer matches the page payload, so close
	// silently and let the navigation stand (review 08 F1).
	$effect(() => {
		if (!open) return;
		if (openedSnapshotId !== null && (photo?.id ?? null) !== openedSnapshotId) {
			closeSilently();
		}
	});

	// Unmount while open (e.g. a browser Back): clean up, never re-enter the
	// parent's close handling - the page is already navigating away.
	onDestroy(teardown);

	function initialize() {
		// The two modes are mutually exclusive by contract (see Props): the
		// feed host passes photo/neighbors/position, the article lightbox
		// passes plain - and `plain` wins if both were ever supplied.
		plainItem = plain ?? null;
		current = plainItem ? null : (photo ?? null);
		currentNeighbors = neighbors;
		currentPosition = position;
		openedSnapshotId = plainItem ? null : (photo?.id ?? null);
		suppressClosed = false;
		transform = identity();
		smooth = false;
		announcement = '';
		if (current) historySync(current.slug);
		scheduleAnnounce();
		void startLoad();
	}

	function closeSilently(): void {
		suppressClosed = true;
		open = false;
	}

	function teardown() {
		loadToken += 1;
		navToken += 1;
		controller?.abort();
		controller = null;
		windowController?.abort();
		windowController = null;
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
		// Invalidate any in-flight load FIRST: the on-demand early return must
		// not leave the previous photo's stream alive with a still-valid token
		// (it would land as THIS photo's blob and hide the load button -
		// review 01 P1).
		const token = ++loadToken;
		controller?.abort();
		controller = null;
		if (plainItem === null && current === null) return;
		if (plainItem !== null && plainItem.fullSrc === plainItem.src) {
			// Content mode where the displayed frame already IS the full image
			// (external URLs, bare GIF keys): nothing to stream (3d).
			phase = 'ready';
			return;
		}
		if (!force && onDemand) {
			phase = 'waiting';
			return;
		}
		const fullSrc = fullOf();
		if (fullSrc === null) return;
		const ctl = new AbortController();
		controller = ctl;
		phase = 'loading';
		loadedBytes = 0;
		const fallbackSize = byteSizeOf();
		totalBytes = typeof fallbackSize === 'number' ? fallbackSize : null;
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
			const blob = await streamImageBytes(fullSrc, {
				signal: ctl.signal,
				fallbackTotal: totalBytes,
				onProgress: (progress) => {
					if (token !== loadToken) return; // superseded stream
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
	let windowController: AbortController | null = null;
	async function navigate(direction: 'newer' | 'older'): Promise<void> {
		if (!current) return; // plain mode: nothing to walk
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
		windowController?.abort();
		const ctl = new AbortController();
		windowController = ctl;
		try {
			const response = await fetch(`/api/photo-neighbors?slug=${encodeURIComponent(slug)}`, {
				signal: ctl.signal
			});
			if (!response.ok) {
				if (import.meta.env.DEV) {
					console.warn('[photos-viewer] neighbour window failed', slug, response.status);
				}
				return;
			}
			const payload = (await response.json()) as {
				slug: string;
				newer: PhotoViewerSource | null;
				older: PhotoViewerSource | null;
				position: { index: number; total: number };
			};
			if (token !== navToken || payload.slug !== slug) return;
			currentNeighbors = { newer: payload.newer ?? null, older: payload.older ?? null };
			currentPosition = payload.position;
		} catch (error) {
			if (ctl.signal.aborted) return;
			// Offline: the provisional window still allows backtracking.
			if (import.meta.env.DEV) {
				console.warn('[photos-viewer] neighbour window failed', slug, error);
			}
		}
	}

	function historySync(slug: string): void {
		// Defence in depth: slugs are DB-generated and already validated, and a
		// malformed value must never reach the address bar (siteHref passes
		// non-root paths through verbatim - review 02 P3-3).
		if (!isPhotoSlug(slug)) return;
		const href = siteHref(`/photos/${slug}`);
		try {
			// Kit's shallow replace keeps the router snapshot in sync. It throws
			// when the router has not started (dev / isolated mounts), so fall
			// back to the raw history API there; both branches clear state.
			replaceState(href, {});
		} catch {
			if (typeof history !== 'undefined') history.replaceState({}, '', href);
		}
	}

	// ── Prefetch ±1 (Q13: thumb + preview only) ──
	const prefetched = new SvelteSet<string>();
	function preloadOnce(src: string): void {
		// The cache is bookkeeping, not signal: untrack its reads/writes so the
		// prefetch effect does not re-trigger on its own adds.
		if (untrack(() => prefetched.has(src))) return;
		untrack(() => prefetched.add(src));
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
		if (!current) return; // plain mode has no feed position to announce
		if (announceTimer) clearTimeout(announceTimer);
		announceTimer = setTimeout(() => {
			if (!open || !current) return;
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
		} else if (
			key === 'ArrowLeft' ||
			key === 'ArrowRight' ||
			key === 'ArrowUp' ||
			key === 'ArrowDown'
		) {
			event.preventDefault();
			if (event.shiftKey) {
				// WCAG 2.5.7 (plan §5.3): a non-drag path for panning, effective
				// while zoomed; plain arrows keep navigating neighbours.
				const dx = key === 'ArrowLeft' ? PAN_KEY_STEP : key === 'ArrowRight' ? -PAN_KEY_STEP : 0;
				const dy = key === 'ArrowUp' ? PAN_KEY_STEP : key === 'ArrowDown' ? -PAN_KEY_STEP : 0;
				smooth = true;
				transform = panBy(transform, dx, dy, viewportSize(), contentSize());
			} else if (key === 'ArrowLeft') {
				void navigate('newer');
			} else if (key === 'ArrowRight') {
				void navigate('older');
			}
			return;
		} else {
			return;
		}
		event.preventDefault();
	}

	/** Viewport-fraction pan step for the keyboard path (2.5.7). */
	const PAN_KEY_STEP = 80;

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

	function onPanDown(event: CustomEvent): void {
		// The first `pan` event arrives on the first move - using it as the
		// origin would silently drop the down-to-first-move segment (the probe
		// behind review 08 F3 showed a 100px swipe measuring 50px). The down
		// dispatch carries the pointer's node-relative position: use it.
		const detail = (event as CustomEvent<{ x?: number; y?: number }>).detail;
		panStart =
			typeof detail?.x === 'number' && typeof detail?.y === 'number'
				? { x: detail.x, y: detail.y }
				: null;
		panLast = panStart;
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
		// The synthetic click after a drag must stay suppressed even when the UA
		// delivers it in a later task (touch): hold the flag for a short window,
		// then let the next clean tap close again.
		setTimeout(() => {
			panMoved = false;
		}, 300);
	}

	let pinchBase: ViewerTransform | null = null;
	function onPinch(event: PinchCustomEvent): void {
		const { scale, center } = event.detail;
		if (!pinchBase) pinchBase = transform;
		smooth = false;
		// The library reports `center` relative to the bound node (it already
		// subtracted the node rect): convert to stage-centre coords directly -
		// centerCoords() expects client coords and would subtract the rect
		// twice (masked today only because the stage fills the viewport).
		const viewport = viewportSize();
		transform = zoomAt(
			pinchBase,
			scale,
			{ x: center.x - viewport.width / 2, y: center.y - viewport.height / 2 },
			viewport,
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
		class="fixed inset-0 top-0 left-0 z-50 h-full w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none ring-0 outline-none motion-reduce:animate-none sm:max-w-none"
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<Dialog.Title class="sr-only">{title}</Dialog.Title>
		{#if alt && alt !== title}
			<Dialog.Description class="sr-only">{alt}</Dialog.Description>
		{/if}
		<div class="absolute inset-0 bg-black/[0.92]" aria-hidden="true"></div>

		<div
			bind:this={stageEl}
			data-photos-viewer-stage
			class="absolute inset-0 flex touch-none items-center justify-center overflow-hidden"
			use:wheelListener
			{...usePan(onPan, () => ({ touchAction: 'none', delay: 0 }), {
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
						: ''} {brokenSrc === displaySrc ? 'pointer-events-none' : ''}"
					src={displaySrc}
					{alt}
					draggable="false"
					width={widthOf() ?? undefined}
					height={heightOf() ?? undefined}
					style="{transformStyle}{!objectUrl && placeholder
						? `background-image:url(${placeholder});background-size:cover;background-position:center;`
						: ''}"
					decoding="async"
					onerror={() => (brokenSrc = displaySrc)}
					onload={() => {
						if (brokenSrc === displaySrc) brokenSrc = null;
					}}
					data-phase={phase}
				/>
			{:else}
				<!-- On-demand GIF: no tier exists before the click; hold the box. -->
				<div
					class="max-h-full w-full max-w-full rounded-lg bg-muted/40"
					style={widthOf() && heightOf()
						? `aspect-ratio:${widthOf()}/${heightOf()};${transformStyle}`
						: `min-height:40vh;${transformStyle}`}
					aria-hidden="true"
					data-phase={phase}
				></div>
			{/if}
		</div>

		<!-- Counter (top centre) + close (top right) -->
		{#if !plainItem}
			<p
				data-photos-viewer-counter
				class="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 font-mono text-xs text-white/90 [text-shadow:0_1px_3px_rgb(0_0_0/0.8)]"
			>
				{currentPosition.index} / {currentPosition.total}
			</p>
		{/if}
		<Dialog.Close
			bind:ref={closeButton}
			class="absolute top-3 right-3 z-20 flex size-10 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:shadow-[0_0_0_2px_rgba(0,0,0,0.6)] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
			aria-label={m.photos_viewer_close()}
		>
			<IconX class="size-5" aria-hidden="true" />
		</Dialog.Close>

		<!-- Bottom bar: prev / caption (= alt, Q13) / next -->
		<div
			class="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-10 pb-3"
		>
			{#if !plainItem}
				<button
					type="button"
					class="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white transition-colors hover:bg-black/70 focus-visible:shadow-[0_0_0_2px_rgba(0,0,0,0.6)] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-30 disabled:hover:bg-black/50"
					aria-label={m.photos_prev()}
					disabled={!currentNeighbors.newer}
					onclick={() => void navigate('newer')}
				>
					<span aria-hidden="true">‹</span>
				</button>
			{/if}
			<p
				data-photos-viewer-caption
				aria-hidden="true"
				class="min-w-0 flex-1 truncate text-center text-sm text-white/90 [text-shadow:0_1px_3px_rgb(0_0_0/0.8)]"
			>
				{alt}
			</p>
			{#if !plainItem}
				<button
					type="button"
					class="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white transition-colors hover:bg-black/70 focus-visible:shadow-[0_0_0_2px_rgba(0,0,0,0.6)] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-30 disabled:hover:bg-black/50"
					aria-label={m.photos_next()}
					disabled={!currentNeighbors.older}
					onclick={() => void navigate('older')}
				>
					<span aria-hidden="true">›</span>
				</button>
			{/if}
		</div>

		<!-- Loading floater / on-demand button (own DOM; shared policy) -->
		{#if phase === 'waiting'}
			<div class="absolute right-4 bottom-20 z-30">
				<button
					type="button"
					class="rounded-xl border border-white/20 bg-black/60 px-4 py-2.5 text-sm text-white backdrop-blur transition-colors hover:bg-black/80 focus-visible:shadow-[0_0_0_2px_rgba(0,0,0,0.6)] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
					onclick={() => void startLoad(true)}
				>
					{plainItem
						? m.photos_viewer_load_full_plain()
						: m.photos_viewer_load_full({ size: byteSizeLabel() })}
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
						class="rounded-md border border-white/45 px-3 py-1.5 text-sm transition-colors hover:bg-white/10 focus-visible:shadow-[0_0_0_2px_rgba(0,0,0,0.6)] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
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

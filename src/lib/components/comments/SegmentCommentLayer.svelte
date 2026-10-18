<script lang="ts">
	import { tick } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import CommentComposer from './CommentComposer.svelte';
	import CommentItem from './CommentItem.svelte';
	import {
		collectDomBlocks,
		selectionToAnchor,
		type DomBlock,
		type SegmentSelection
	} from './segment-dom';
	import type { CommentFormState, ThreadRoot, ThreadsPage } from './types';

	/**
	 * Segment-comment interaction layer (comment P3b, spec §5/§8).
	 *
	 * Owns what only the browser can know: mapping the current DOM selection to
	 * an anchor draft, the floating action, the composer panel and the in-place
	 * thread opened from a mark. The server stays authoritative: everything this
	 * component submits is re-derived and re-validated there (ord -> block ->
	 * range/quote).
	 */
	interface Props {
		/** Element that wraps the rendered article (`.markdown-body` inside). */
		container: HTMLElement | null;
		threads: ThreadsPage;
		canComment: boolean;
		loginUrl: string | null;
		/** Latest form-action result: a stale anchor must be visible in the panel. */
		form?: CommentFormState | null;
	}
	let { container, threads, canComment, loginUrl, form = null }: Props = $props();

	// Raw: the block directory is a plain tree snapshot, not UI state. Wrapping
	// thousands of points in deep proxies cost 13x on the hot boundary loop
	// (B2 review, angle 1).
	let blocks = $state.raw<DomBlock[] | null>(null);
	let blocksDirty = true;
	let selected = $state<SegmentSelection | null>(null);
	let composerOpen = $state(false);
	let activeThreadId = $state<string | null>(null);
	let threadRect = $state<{ left: number; top: number } | null>(null);
	let panelEl = $state<HTMLElement | null>(null);
	let threadEl = $state<HTMLElement | null>(null);
	let closeThreadEl = $state<HTMLButtonElement | null>(null);
	/** Focus targets for the two overlays; one slot was clobbered by the other. */
	let composerReturnFocus: HTMLElement | null = null;
	let threadReturnFocus: HTMLElement | null = null;
	/** Narrow viewport: composer and thread become bottom sheets (spec §5). */
	let narrow = $state(false);
	/** Desktop hover summary card (spec §7); decorative, never interactive. */
	let hovered = $state<{ root: ThreadRoot; left: number; top: number; above: boolean } | null>(
		null
	);

	let scheduleTimer = 0;
	let hoverTimer = 0;

	/** The article finished hydrating: e2e readiness + first-use build gate. */
	let ready = $state(false);

	const activeThread = $derived(
		activeThreadId === null
			? null
			: (threads.roots.find((root) => root.id === activeThreadId) ?? null)
	);

	// A refresh can drop the open thread (deleted root, moderation change): the
	// snapshot must never outlive the prop it came from.
	$effect(() => {
		if (activeThreadId !== null && activeThread === null) {
			activeThreadId = null;
			threadRect = null;
		}
	});

	function ensureBlocks(host: HTMLElement): DomBlock[] {
		if (blocks === null || blocksDirty) {
			blocks = collectDomBlocks(host);
			blocksDirty = false;
		}
		return blocks;
	}

	function clearHover() {
		window.clearTimeout(hoverTimer);
		hovered = null;
	}

	function hideFloating() {
		clearHover();
		if (composerOpen) return;
		selected = null;
	}

	function onSelectionSettled(host: HTMLElement) {
		if (composerOpen) return;
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
			selected = null;
			return;
		}
		selected = selectionToAnchor(host, selection, ensureBlocks(host));
	}

	function scheduleSelection(host: HTMLElement) {
		window.clearTimeout(scheduleTimer);
		scheduleTimer = window.setTimeout(() => onSelectionSettled(host), 120);
	}

	function openComposer() {
		if (!selected) return;
		clearHover();
		// Return target for 2.4.3: the action button unmounts with the panel, and
		// the selection block itself is not focusable.
		composerReturnFocus = document.getElementById('comments-title');
		composerOpen = true;
	}

	async function closeComposer(restoreFocus = true) {
		const target = composerReturnFocus;
		composerOpen = false;
		selected = null;
		composerReturnFocus = null;
		window.getSelection()?.removeAllRanges();
		// The page is inert while the overlay is open; wait for the effect to
		// lift it before moving focus, or the focus call is silently ignored.
		await tick();
		if (restoreFocus && target?.isConnected) target.focus();
	}

	async function openThread(mark: Element) {
		// A cluster carries every id; the representative (`data-cid`) can be a
		// deleted root or another reader's comment, so pick the first id the
		// reader can actually open.
		const ids = (mark.getAttribute('data-cids') ?? mark.getAttribute('data-cid') ?? '')
			.split(/\s+/)
			.filter(Boolean);
		if (ids.length === 0) return;
		const commentId = ids.find((id) => threads.roots.some((root) => root.id === id));
		if (!commentId) {
			// Nothing in this cluster is renderable: park the reader on the list.
			document
				.querySelector<HTMLElement>(`[data-comment-id="${ids[0]}"]`)
				?.scrollIntoView({ block: 'center' });
			return;
		}
		clearHover();
		// One surface at a time: the composer and the thread used to stack.
		// Suppress the focus return here; it would scroll before the rect is read.
		if (composerOpen) void closeComposer(false);
		// Only the cluster's first span is focusable; other spans would make the
		// focus return a silent no-op.
		const focusTarget = document.getElementById(`c-${commentId}`);
		threadReturnFocus =
			focusTarget instanceof HTMLElement ? focusTarget : mark instanceof HTMLElement ? mark : null;
		const rect = mark.getBoundingClientRect();
		threadRect = {
			left: Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 360)),
			top: Math.min(Math.max(rect.bottom + 8, 8), Math.max(8, window.innerHeight - 380))
		};
		activeThreadId = commentId;
		await tick();
		closeThreadEl?.focus();
	}

	async function closeThread(restoreFocus = true) {
		const target = threadReturnFocus;
		activeThreadId = null;
		threadRect = null;
		threadReturnFocus = null;
		// Focus return on Escape/Close (2.4.3); an outside pointerdown must not
		// yank focus back to the mark the reader just clicked away from.
		await tick();
		if (restoreFocus && target?.isConnected) target.focus();
	}

	function showHover(mark: Element, commentId: string) {
		if (composerOpen || activeThread || selected) return;
		const root = threads.roots.find((item) => item.id === commentId);
		if (!root) return;
		const rect = mark.getBoundingClientRect();
		const above = rect.top > 110;
		hovered = {
			root,
			left: Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 272)),
			top: above ? rect.top - 8 : rect.bottom + 8,
			above
		};
	}

	$effect(() => {
		const host = container;
		if (!host) return;
		// No eager walk: a page nobody selects in never pays for the directory.
		ready = true;
		blocksDirty = true;
		const hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

		const onSelectionEvent = () => scheduleSelection(host);
		const onPointerUp = () => scheduleSelection(host);
		const onScroll = () => hideFloating();
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as Element | null;
			const mark = target?.closest?.('.wl-cm');
			if (mark && host.contains(mark) && (event.key === 'Enter' || event.key === ' ')) {
				// Marks are buttons for keyboard users too (WCAG 2.1.1).
				event.preventDefault();
				void openThread(mark);
				return;
			}
			if (event.key === 'Tab') {
				// The sheet/popover is modal (the page behind is inert): keep Tab
				// inside it per the APG modal-dialog pattern; Escape is the exit,
				// so 2.1.2 (no keyboard trap) still holds, and 2.4.3 covers the
				// focus return. (2.4.11 is Focus Not Obscured, a different rule.)
				const surface = composerOpen ? panelEl : activeThread ? threadEl : null;
				if (surface) {
					const focusables = [
						...surface.querySelectorAll<HTMLElement>(
							'button:not([disabled]), [href], textarea, input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])'
						)
					];
					const first = focusables[0];
					const last = focusables[focusables.length - 1];
					if (first && last && !surface.contains(document.activeElement)) {
						event.preventDefault();
						first.focus();
					} else if (first && last) {
						if (!event.shiftKey && document.activeElement === last) {
							event.preventDefault();
							first.focus();
						} else if (event.shiftKey && document.activeElement === first) {
							event.preventDefault();
							last.focus();
						}
					}
				}
				return;
			}
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			clearHover();
			if (composerOpen) void closeComposer();
			else if (activeThread) void closeThread();
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element | null;
			const mark = target?.closest?.('.wl-cm');
			if (!mark || !host.contains(mark)) return;
			// Link-hosted marks are presentation-only: the link owns the click,
			// and its thread stays reachable from the list (B2 review round 4).
			if (mark.closest('a')) return;
			void openThread(mark);
		};
		const onPointerOver = (event: PointerEvent) => {
			if (!hoverCapable || event.pointerType !== 'mouse') return;
			const target = event.target as Element | null;
			const mark = target?.closest?.('.wl-cm');
			if (!mark || !host.contains(mark)) return;
			const commentId = mark.getAttribute('data-cid');
			if (!commentId) return;
			window.clearTimeout(hoverTimer);
			// Hover is a preview, not a control: delay it so a passing pointer
			// does not flicker cards over the text.
			hoverTimer = window.setTimeout(() => showHover(mark, commentId), 150);
		};
		const onPointerOut = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target?.closest?.('.wl-cm')) return;
			clearHover();
		};
		const onDocPointerDown = (event: PointerEvent) => {
			// Only a thread can be closed here; running this while the composer is
			// open used to clear its focus slot as a side effect.
			if (activeThreadId === null) return;
			const target = event.target as Node | null;
			if (!target) return;
			if (panelEl?.contains(target)) return;
			// The thread popover owns its own clicks: without this guard every
			// pointerdown inside it (reply, edit, close) closed it before click.
			if (threadEl?.contains(target)) return;
			if ((target as Element).closest?.('.wl-cm')) return;
			void closeThread(false);
		};

		// The `{@html}` swap replaces the article's children after every
		// submission: the block map must be re-derived, or the next selection
		// would be resolved against dead nodes.
		const observer = new MutationObserver(() => {
			blocksDirty = true;
		});
		observer.observe(host, { childList: true, subtree: true, characterData: true });

		document.addEventListener('selectionchange', onSelectionEvent);
		host.addEventListener('pointerup', onPointerUp);
		window.addEventListener('scroll', onScroll, { passive: true });
		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('pointerdown', onDocPointerDown);
		host.addEventListener('click', onClick);
		host.addEventListener('pointerover', onPointerOver);
		host.addEventListener('pointerout', onPointerOut);

		return () => {
			ready = false;
			window.clearTimeout(scheduleTimer);
			window.clearTimeout(hoverTimer);
			hovered = null;
			observer.disconnect();
			document.removeEventListener('selectionchange', onSelectionEvent);
			host.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('scroll', onScroll);
			document.removeEventListener('keydown', onKeyDown);
			document.removeEventListener('pointerdown', onDocPointerDown);
			host.removeEventListener('click', onClick);
			host.removeEventListener('pointerover', onPointerOver);
			host.removeEventListener('pointerout', onPointerOut);
		};
	});

	// Desktop popover / mobile bottom sheet (spec §5). CSS cannot switch the
	// inline position, so the shape is a state decision.
	$effect(() => {
		const query = window.matchMedia('(max-width: 40rem)');
		const update = () => {
			narrow = query.matches;
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// Modal surfaces: the page behind must not stay interactive (APG modal
	// dialog; aria-modal would otherwise over-promise).
	$effect(() => {
		const host = container;
		if (!host) return;
		const blocking = composerOpen || activeThreadId !== null;
		const section = document.getElementById('comments');
		host.inert = blocking;
		if (section) section.inert = blocking;
		return () => {
			host.inert = false;
			if (section) section.inert = false;
		};
	});

	// Keep the composer panel focused when it opens (popover etiquette).
	$effect(() => {
		if (composerOpen) panelEl?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
	});

	const floatingStyle = $derived.by(() => {
		if (!selected) return '';
		const rect = selected.rect;
		const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 180));
		const above = rect.top - 44;
		const top = above > 8 ? above : rect.bottom + 8;
		return `left:${left}px;top:${top}px`;
	});
</script>

<!-- Client-only mount marker: e2e readiness (hydration) and block count for diagnostics. -->
<span
	data-slot="segment-layer"
	data-ready={ready ? 'true' : 'false'}
	data-blocks={blocks?.length ?? 0}
	hidden
></span>

{#if hovered && !selected && !composerOpen && !activeThread}
	<!-- Desktop preview only: aria-hidden because the popover is the surface. -->
	<div
		class="pointer-events-none fixed z-40 w-64 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
		class:-translate-y-full={hovered.above}
		style={`left:${hovered.left}px;top:${hovered.top}px`}
		aria-hidden="true"
		data-slot="comment-mark-hover"
	>
		<p class="line-clamp-2 text-muted-foreground">{hovered.root.anchor?.quote ?? ''}</p>
		<p class="mt-1 truncate font-medium">{hovered.root.author ?? ''}</p>
		<p class="line-clamp-2 text-muted-foreground">{hovered.root.text}</p>
	</div>
{/if}

{#if selected && !composerOpen && !activeThread}
	<button
		type="button"
		class="fixed z-40 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
		style={floatingStyle}
		data-slot="comment-selection-action"
		onclick={openComposer}
	>
		{m.comment_segment_action()}
	</button>
{/if}

{#if composerOpen && selected}
	<div
		bind:this={panelEl}
		class={narrow
			? 'fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-auto rounded-t-xl border-t border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl'
			: 'fixed z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-xl'}
		style={narrow ? '' : floatingStyle}
		role="dialog"
		aria-modal="true"
		aria-label={m.comment_segment_action()}
		data-slot="comment-selection-panel"
		data-shape={narrow ? 'sheet' : 'popover'}
	>
		{#if narrow}
			<div class="mx-auto mb-2 h-1 w-10 rounded-full bg-border" aria-hidden="true"></div>
		{/if}
		<p class="mb-2 line-clamp-2 text-xs text-muted-foreground">
			{m.comment_segment_quote({ quote: selected.exact })}
		</p>
		{#if form?.message}
			<p class="mb-2 text-xs text-destructive" role="alert">{form.message}</p>
		{/if}
		{#if canComment}
			<CommentComposer
				action="?/comment"
				onCancel={() => void closeComposer()}
				hiddenValues={{
					anchorOrd: String(selected.ord),
					anchorStart: String(selected.start),
					anchorEnd: String(selected.end),
					anchorExact: selected.exact,
					anchorLength: String(selected.blockLength),
					anchorFingerprint: selected.blockFingerprint
				}}
			/>
		{:else if loginUrl}
			<p class="text-sm text-muted-foreground">
				{m.comment_login_prompt()}
				<a class="wl-accent-link underline underline-offset-2" href={loginUrl}>
					{m.comment_login_action()}
				</a>
			</p>
			<button
				type="button"
				class="mt-2 inline-flex min-h-6 items-center px-1.5 text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
				onclick={() => void closeComposer()}>{m.comment_segment_close()}</button
			>
		{:else}
			<p class="text-sm text-muted-foreground">{m.comment_verify_hint()}</p>
			<button
				type="button"
				class="mt-2 inline-flex min-h-6 items-center px-1.5 text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
				onclick={() => void closeComposer()}>{m.comment_segment_close()}</button
			>
		{/if}
	</div>
{/if}

{#if activeThread && threadRect}
	<div
		bind:this={threadEl}
		class={narrow
			? 'fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-auto rounded-t-xl border-t border-border bg-card pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl'
			: 'fixed z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card shadow-xl'}
		style={narrow ? '' : `left:${threadRect.left}px;top:${threadRect.top}px`}
		role="dialog"
		aria-modal="true"
		aria-label={m.comment_segment_thread()}
		data-slot="comment-thread-popover"
		data-shape={narrow ? 'sheet' : 'popover'}
	>
		<div class="flex items-center justify-between border-b border-border/50 px-3 py-2">
			<span class="text-xs font-medium text-muted-foreground">{m.comment_segment_thread()}</span>
			<button
				type="button"
				bind:this={closeThreadEl}
				class="inline-flex min-h-6 items-center rounded-sm px-1.5 text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
				onclick={() => void closeThread()}>{m.comment_segment_close()}</button
			>
		</div>
		{#if form?.message}
			<!-- #comments is inert while the popover is open, so its alert would
			     never be announced; surface reply/edit failures here instead. -->
			<p class="px-3 pt-2 text-xs text-destructive" role="alert">{form.message}</p>
		{/if}
		<ul class="max-h-80 overflow-auto px-3">
			<CommentItem root={activeThread} {canComment} />
		</ul>
	</div>
{/if}

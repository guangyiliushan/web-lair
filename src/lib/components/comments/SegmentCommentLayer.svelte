<script lang="ts">
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

	let blocks = $state<DomBlock[]>([]);
	let selected = $state<SegmentSelection | null>(null);
	let composerOpen = $state(false);
	let activeThread = $state<ThreadRoot | null>(null);
	let threadRect = $state<{ left: number; top: number } | null>(null);
	let panelEl = $state<HTMLElement | null>(null);

	let scheduleTimer = 0;

	function refreshBlocks(host: HTMLElement) {
		blocks = collectDomBlocks(host);
	}

	function hideFloating() {
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
		selected = selectionToAnchor(host, selection, blocks);
	}

	function scheduleSelection(host: HTMLElement) {
		window.clearTimeout(scheduleTimer);
		scheduleTimer = window.setTimeout(() => onSelectionSettled(host), 120);
	}

	function openComposer() {
		if (!selected) return;
		composerOpen = true;
	}

	function closeComposer() {
		composerOpen = false;
		selected = null;
		window.getSelection()?.removeAllRanges();
	}

	function openThread(mark: Element) {
		const commentId = mark.getAttribute('data-cid');
		if (!commentId) return;
		const rect = mark.getBoundingClientRect();
		threadRect = {
			left: Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 360)),
			top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 240))
		};
		activeThread = threads.roots.find((root) => root.id === commentId) ?? null;
		if (!activeThread) {
			// Cluster representative mismatch: park the reader on the list entry.
			document
				.querySelector<HTMLElement>(`[data-comment-id="${commentId}"]`)
				?.scrollIntoView({ block: 'center' });
		}
	}

	function closeThread() {
		activeThread = null;
		threadRect = null;
	}

	$effect(() => {
		const host = container;
		if (!host) return;
		refreshBlocks(host);

		const onSelectionEvent = () => scheduleSelection(host);
		const onPointerUp = () => scheduleSelection(host);
		const onScroll = () => hideFloating();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (composerOpen) closeComposer();
			else if (activeThread) closeThread();
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element | null;
			const mark = target?.closest?.('.wl-cm');
			if (!mark || !host.contains(mark)) return;
			openThread(mark);
		};
		const onDocPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (panelEl?.contains(target)) return;
			if ((target as Element).closest?.('.wl-cm')) return;
			closeThread();
		};

		// The `{@html}` swap replaces the article's children after every
		// submission: the block map must be re-derived, or the next selection
		// would be resolved against dead nodes.
		const observer = new MutationObserver(() => refreshBlocks(host));
		observer.observe(host, { childList: true, subtree: true });

		document.addEventListener('selectionchange', onSelectionEvent);
		host.addEventListener('pointerup', onPointerUp);
		window.addEventListener('scroll', onScroll, { passive: true });
		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('pointerdown', onDocPointerDown);
		host.addEventListener('click', onClick);

		return () => {
			window.clearTimeout(scheduleTimer);
			observer.disconnect();
			document.removeEventListener('selectionchange', onSelectionEvent);
			host.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('scroll', onScroll);
			document.removeEventListener('keydown', onKeyDown);
			document.removeEventListener('pointerdown', onDocPointerDown);
			host.removeEventListener('click', onClick);
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
<span data-slot="segment-layer" data-blocks={blocks.length} hidden></span>

{#if selected && !composerOpen && !activeThread}
	<button
		type="button"
		class="fixed z-40 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
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
		class="fixed z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-xl"
		style={floatingStyle}
		role="dialog"
		aria-label={m.comment_segment_action()}
		data-slot="comment-selection-panel"
	>
		<p class="mb-2 line-clamp-2 text-xs text-muted-foreground">
			{m.comment_segment_quote({ quote: selected.exact })}
		</p>
		{#if form?.message}
			<p class="mb-2 text-xs text-destructive" role="alert">{form.message}</p>
		{/if}
		{#if canComment}
			<CommentComposer
				action="?/comment"
				onCancel={closeComposer}
				hiddenValues={{
					anchorOrd: String(selected.ord),
					anchorStart: String(selected.start),
					anchorEnd: String(selected.end),
					anchorExact: selected.exact
				}}
			/>
		{:else if loginUrl}
			<p class="text-sm text-muted-foreground">
				{m.comment_login_prompt()}
				<a class="text-primary underline underline-offset-2" href={loginUrl}>
					{m.comment_login_action()}
				</a>
			</p>
			<button
				type="button"
				class="mt-2 text-xs text-muted-foreground underline underline-offset-2"
				onclick={closeComposer}>{m.comment_segment_close()}</button
			>
		{:else}
			<p class="text-sm text-muted-foreground">{m.comment_verify_hint()}</p>
			<button
				type="button"
				class="mt-2 text-xs text-muted-foreground underline underline-offset-2"
				onclick={closeComposer}>{m.comment_segment_close()}</button
			>
		{/if}
	</div>
{/if}

{#if activeThread && threadRect}
	<div
		class="fixed z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card shadow-xl"
		style={`left:${threadRect.left}px;top:${threadRect.top}px`}
		role="dialog"
		aria-label={m.comment_segment_thread()}
		data-slot="comment-thread-popover"
	>
		<div class="flex items-center justify-between border-b border-border/50 px-3 py-2">
			<span class="text-xs font-medium text-muted-foreground">{m.comment_segment_thread()}</span>
			<button
				type="button"
				class="rounded-sm text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				onclick={closeThread}>{m.comment_segment_close()}</button
			>
		</div>
		<ul class="max-h-80 overflow-auto px-3">
			<CommentItem root={activeThread} {canComment} />
		</ul>
	</div>
{/if}

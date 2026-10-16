<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import {
		elementProgress,
		getOrCreatePresenceToken,
		openPresenceStream,
		positionBucket,
		sendPresenceHeartbeat,
		startPresenceHeartbeat,
		PRESENCE_POSITION_DELTA,
		PRESENCE_POSITION_MS
	} from './presence-client';

	/**
	 * Reader presence widget (realtime R3, ledger §23): the "N reading now"
	 * badge (meta row, right side) and the 20-segment position density strip
	 * (absolutely anchored under the header, so appearing/disappearing never
	 * shifts layout; the page header is `relative`). Counts include the
	 * current reader; the badge hides for 0 and for degraded snapshots.
	 */

	interface PresenceConfig {
		enabled: boolean;
		readerView: boolean;
		readerDots: boolean;
	}

	interface PresencePayload {
		content?: { count: number; hist: number[] } | null;
		dots?: number[] | null;
	}

	interface Props {
		contentId: string;
		config: PresenceConfig;
	}

	let { contentId, config }: Props = $props();

	let count = $state<number | null>(null);
	let histogram = $state<number[]>([]);
	let dots = $state<number[]>([]);

	let lastReportedPercent = 0;
	let lastReportedAt = 0;

	let root: HTMLElement | undefined;

	const maxHistogram = $derived(Math.max(1, ...histogram));

	$effect(() => {
		if (!config.enabled || typeof window === 'undefined') return;
		const token = getOrCreatePresenceToken();
		const article = root?.closest('article') ?? null;

		const readPercent = (): number => {
			const rect = article?.getBoundingClientRect();
			if (!rect) return 0;
			return elementProgress({ top: rect.top, height: rect.height }, window.innerHeight);
		};

		// Early position reports (register D2): a ≥2% move AND the 5s client
		// floor while scrolling — the 15s loop carries the latest bucket and
		// keeps counting while idle. Rides one rAF per frame at most.
		let raf = 0;
		const onScroll = (): void => {
			if (raf !== 0) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const percent = readPercent();
				const now = Date.now();
				if (
					Math.abs(percent - lastReportedPercent) >= PRESENCE_POSITION_DELTA &&
					now - lastReportedAt >= PRESENCE_POSITION_MS
				) {
					lastReportedPercent = percent;
					lastReportedAt = now;
					void sendPresenceHeartbeat(token, {
						contentId,
						bucket: positionBucket(percent)
					});
				}
			});
		};

		const stopHeartbeat = startPresenceHeartbeat({
			token,
			context: () => ({ contentId, bucket: positionBucket(readPercent()) })
		});
		// The stream feeds the reader display only; readerView off hides the
		// widget but the heartbeats keep flowing (admin stats stay live).
		const stopStream = config.readerView
			? openPresenceStream({
					url: `/api/presence/stream?c=${encodeURIComponent(contentId)}`,
					onSnapshot: (payload) => {
						const data = payload as PresencePayload;
						const content = data.content;
						if (content === null || content === undefined) {
							count = null;
							histogram = [];
							dots = [];
							return;
						}
						count = content.count;
						histogram = Array.isArray(content.hist) ? content.hist : [];
						dots = Array.isArray(data.dots) ? data.dots : [];
					}
				})
			: null;
		window.addEventListener('scroll', onScroll, { passive: true });

		return () => {
			window.removeEventListener('scroll', onScroll);
			if (raf !== 0) cancelAnimationFrame(raf);
			stopHeartbeat();
			stopStream?.();
		};
	});
</script>

<span class="contents" bind:this={root}>
	{#if config.enabled && config.readerView && count !== null && count >= 1}
		<span class="ml-auto inline-flex items-center gap-1.5" data-slot="presence-badge">
			<span class="relative flex size-1.5" aria-hidden="true">
				<span
					class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none"
				></span>
				<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
			</span>
			<span data-slot="presence-count">{m.presence_readers_now({ count: count })}</span>
		</span>
		{#if histogram.length > 0}
			<span
				class="absolute inset-x-0 top-full mt-2 block"
				aria-hidden="true"
				title={m.presence_density_label()}
				data-slot="presence-strip"
			>
				<span class="relative block">
					<span class="flex h-0.5 items-stretch gap-px">
						{#each histogram as value, index (index)}
							<span
								class="flex-1 rounded-[1px] bg-primary"
								style="opacity: {value === 0
									? 0.08
									: Math.min(1, 0.25 + (0.75 * value) / maxHistogram)}"
							></span>
						{/each}
					</span>
					{#if config.readerDots && dots.length > 0}
						{#each dots as bucket, index (index)}
							<span
								class="absolute size-1 rounded-full bg-primary/60"
								style="left: {((bucket + 0.5) * 100) / histogram.length}%; top: {-7 -
									(index % 3) * 3}px"
								data-presence-dot
							></span>
						{/each}
					{/if}
				</span>
			</span>
			<span class="sr-only">{m.presence_density_label()}</span>
		{/if}
	{/if}
</span>

<script lang="ts">
	/**
	 * Embed card component (spec 3.4) — mounted over the placeholder anchors
	 * produced by remark-image-embed. The static baseline renders from the URL
	 * itself: no data fetch, no third-party script, no request until a facade
	 * click (spec 6). Facades (youtube, bilibili, tweet) build their embed
	 * source from the URL and mount a sandboxed iframe only after the explicit
	 * click; every other provider stays a readable link card.
	 *
	 * Progressive enrichment (batch 2c): the four core GitHub cards
	 * (gh-repo / gh-commit / gh-pr / gh-issue) fetch metadata from our own
	 * server proxy (/api/embed-meta, cached, rate-limit-safe) after mount and
	 * upgrade to the rich layout below; on any failure they silently keep the
	 * static form. All other providers remain zero-request forever.
	 *
	 * The tweet facade loads platform.twitter.com/embed/Tweet.html directly -
	 * the same document the official widgets.js renders into its frame, but
	 * without injecting Twitter's script into this page (the script route
	 * would run third-party JS in the main world; the iframe stays sandboxed
	 * and dnt=true). The frame gets a fixed height: without widgets.js there
	 * is no resize handshake, so short tweets leave some empty space - the
	 * accepted trade for keeping the no-third-party-script contract.
	 */
	import {
		canonicalHost,
		EMBED_PROVIDER_DOMAINS,
		type EmbedProviderId
	} from '$lib/components/markdown/embed/registry';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { languageColor } from '$lib/components/markdown/embed/language-colors';
	import { m } from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';

	let {
		provider,
		url,
		title,
		editable = false,
		onUrlChange
	}: {
		provider: EmbedProviderId | 'generic';
		url: string;
		title: string;
		/** Editor-context affordances: in-place edit; host handles click-select. */
		editable?: boolean;
		onUrlChange?: (url: string, title: string) => void;
	} = $props();

	// ── Editor-side in-place edit state ──
	let editing = $state(false);
	let draftUrl = $state('');
	let draftTitle = $state('');
	function startEdit() {
		draftUrl = url;
		// prefill with the VISIBLE title so editing matches what is on screen
		draftTitle = displayTitle;
		editing = true;
	}
	function applyEdit() {
		const nextUrl = draftUrl.trim();
		const nextTitle = draftTitle.trim();
		// title untouched == still the displayed value: keep the node's alt
		const resolvedTitle = nextTitle === displayTitle ? title : nextTitle;
		if (nextUrl && (nextUrl !== url || resolvedTitle !== title)) {
			onUrlChange?.(nextUrl, resolvedTitle);
		}
		editing = false;
	}

	/** The only providers that may hit /api/embed-meta; everything else stays static. */
	const ENRICHED_PROVIDERS: ReadonlySet<string> = new Set([
		'gh-repo',
		'gh-commit',
		'gh-pr',
		'gh-issue'
	]);

	/** Whitelisted projection of /api/embed-meta (mirrors the server payload). */
	interface EmbedMeta {
		kind: 'repo' | 'commit' | 'pr' | 'issue';
		title?: string;
		description?: string;
		stars?: number;
		language?: string;
		additions?: number;
		deletions?: number;
		sha?: string;
		state?: string;
		avatarUrl?: string | null;
		repoName?: string;
	}

	let meta = $state<EmbedMeta | null>(null);
	$effect(() => {
		meta = null;
		if (!ENRICHED_PROVIDERS.has(provider)) return;
		const controller = new AbortController();
		fetch(`/api/embed-meta?url=${encodeURIComponent(url)}`, {
			signal: controller.signal,
			headers: { accept: 'application/json' }
		})
			.then((response) => (response.status === 200 ? response.json() : null))
			.then((json) => {
				if (json && typeof json === 'object') meta = json as EmbedMeta;
			})
			.catch(() => {
				/* network failure keeps the static card */
			});
		return () => controller.abort();
	});

	/** Repo language tint: linguist colour, 6% background + border accent. */
	const langColor = $derived(languageColor(meta?.language));
	const cardStyle = $derived.by(() => {
		if (meta?.kind === 'repo' && langColor) return `--lang-color: ${langColor};`;
		// every enriched card sets the variable: the border/glow rules read it
		// unconditionally and an undefined var invalidates the whole declaration
		if (meta) return '--lang-color: var(--muted-foreground);';
		return undefined;
	});

	// ── Spotlight: card-level mousemove, rAF-throttled CSS-variable update ──
	let cardEl: HTMLDivElement | undefined = $state();
	let rafId: number | null = null;
	$effect(() => {
		const el = cardEl;
		if (!el) return;
		const reduced =
			typeof window.matchMedia === 'function'
				? window.matchMedia('(prefers-reduced-motion: reduce)')
				: null;
		const onMove = (event: MouseEvent) => {
			if (!meta || reduced?.matches) return;
			const x = event.clientX;
			const y = event.clientY;
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				const rect = el.getBoundingClientRect();
				el.style.setProperty('--mx', `${(((x - rect.left) / rect.width) * 100).toFixed(2)}%`);
				el.style.setProperty('--my', `${(((y - rect.top) / rect.height) * 100).toFixed(2)}%`);
			});
		};
		el.addEventListener('mousemove', onMove, { passive: true });
		return () => {
			el.removeEventListener('mousemove', onMove);
			if (rafId !== null) cancelAnimationFrame(rafId);
			rafId = null;
		};
	});

	/**
	 * Badges carry the brand name only (Q13: the type suffix lives nowhere
	 * visible); functional text - the generic and own-site labels, the load
	 * button - goes through paraglide.
	 */
	const PROVIDER_BRANDS = {
		'gh-repo': 'GitHub',
		'gh-commit': 'GitHub',
		'gh-pr': 'GitHub',
		'gh-issue': 'GitHub',
		'gh-discussion': 'GitHub',
		'gh-file': 'GitHub',
		'gh-gist': 'GitHub',
		tweet: 'X',
		youtube: 'YouTube',
		bilibili: '哔哩哔哩',
		codesandbox: 'CodeSandbox',
		arxiv: 'arXiv',
		tmdb: 'TMDB',
		bangumi: 'Bangumi',
		'qq-music': 'QQ 音乐',
		'netease-music': '网易云音乐',
		leetcode: 'LeetCode'
	} satisfies Record<Exclude<EmbedProviderId, 'lair'>, string>;
	const label = $derived(
		provider === 'generic'
			? m.md_embed_link()
			: provider === 'lair'
				? m.md_embed_own_site()
				: PROVIDER_BRANDS[provider]
	);

	function facadeSrc(): string | null {
		if (provider === 'youtube') {
			const id = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1];
			return id ? `https://www.youtube.com/embed/${id}` : null;
		}
		if (provider === 'bilibili') {
			const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
			return bv ? `https://player.bilibili.com/player.html?bvid=${bv}` : null;
		}
		if (provider === 'tweet') {
			const id = url.match(/status\/(\d+)/)?.[1];
			return id ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true` : null;
		}
		return null;
	}
	const src = $derived(facadeSrc());
	let loaded = $state(false);
	let iframeEl: HTMLIFrameElement | undefined = $state();

	/** Move focus into the freshly loaded frame (aria-continuity). */
	$effect(() => {
		if (loaded && iframeEl) iframeEl.focus();
	});

	// Favicons only ever come from registry domains (spec 6): the proxy's
	// allowlist is derived from the same registry, and generic cards never
	// request one. Native lazy loading defers the request until the image is
	// near the viewport.
	const faviconSrc = $derived.by(() => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
			return EMBED_PROVIDER_DOMAINS.has(canonicalHost(parsed.hostname))
				? `/api/favicon?url=${encodeURIComponent(parsed.origin)}`
				: null;
		} catch {
			return null;
		}
	});

	// display: the enriched title is the card headline (the design intent
	// locked by embed-card-rich.spec); what is SAVED stays the markdown alt —
	// the edit row edits the visible title and only writes it back on change
	const displayTitle = $derived(meta?.title || title);
</script>

{#if loaded && src}
	<iframe
		bind:this={iframeEl}
		tabindex="-1"
		class={cn('embed-iframe', provider === 'tweet' && 'embed-iframe-tweet')}
		{src}
		{title}
		loading="lazy"
		referrerpolicy="no-referrer"
		sandbox="allow-scripts allow-same-origin allow-presentation"
		allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
	></iframe>
{:else}
	<div bind:this={cardEl} class="embed-card-mount" class:embed-enriched={!!meta} style={cardStyle}>
		{#if meta?.kind === 'repo' && langColor}
			<div class="embed-tint" aria-hidden="true"></div>
			<div class="embed-spotlight" aria-hidden="true"></div>
		{/if}
		{#if meta?.avatarUrl}
			<img
				class="embed-avatar"
				src={meta.avatarUrl}
				alt=""
				loading="lazy"
				referrerpolicy="no-referrer"
			/>
		{/if}
		<div class="embed-card-head">
			{#if faviconSrc}
				<img
					class="embed-favicon"
					src={faviconSrc}
					alt=""
					width="16"
					height="16"
					loading="lazy"
					referrerpolicy="no-referrer"
					onerror={(event) => (event.currentTarget as HTMLImageElement).remove()}
				/>
			{:else}
				<svg class="embed-favicon embed-favicon-default" viewBox="0 0 16 16" aria-hidden="true">
					<path
						fill="none"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linecap="round"
						d="M6.5 9.5 9.5 6.5M6 3.5 7.8 1.7a3 3 0 0 1 4.2 4.2L10.2 7.7M10 12.5l-1.8 1.8a3 3 0 0 1-4.2-4.2l1.8-1.8"
					/>
				</svg>
			{/if}
			<span class="embed-badge">{label}</span>
		</div>
		<span class="embed-title">{displayTitle}</span>
		{#if meta?.description}
			<p class="embed-desc">{meta.description}</p>
		{/if}
		<div class="embed-meta">
			{#if meta?.kind === 'repo' && meta.language}
				<span class="embed-chip">
					<span class="embed-lang-dot" style="background: {langColor}"></span>
					{meta.language}
				</span>
			{/if}
			{#if meta?.kind === 'repo' && typeof meta.stars === 'number'}
				<span class="embed-chip">★ {meta.stars.toLocaleString()}</span>
			{/if}
			{#if (meta?.kind === 'commit' || meta?.kind === 'pr') && typeof meta.additions === 'number'}
				<span class="embed-chip embed-additions">+{meta.additions}</span>
			{/if}
			{#if (meta?.kind === 'commit' || meta?.kind === 'pr') && typeof meta.deletions === 'number'}
				<span class="embed-chip embed-deletions">-{meta.deletions}</span>
			{/if}
			{#if meta?.sha}
				<span class="embed-chip">{meta.sha}</span>
			{/if}
			{#if meta?.repoName}
				<span class="embed-chip">{meta.repoName}</span>
			{/if}
			{#if meta?.kind === 'issue' && meta.state}
				<span class="embed-chip">{meta.state}</span>
			{/if}
			<a class="embed-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
			{#if editable && !editing}
				<Button variant="ghost" size="xs" class="embed-edit" onclick={startEdit}
					>{m.md_embed_edit()}</Button
				>
			{/if}
			{#if src}
				<Button variant="secondary" size="xs" class="embed-load" onclick={() => (loaded = true)}
					>{m.md_embed_load()}</Button
				>
			{/if}
		</div>
		{#if editing}
			<div class="embed-edit-row">
				<Input
					class="embed-edit-input"
					bind:value={draftUrl}
					aria-label={m.md_link_url()}
					onkeydown={(e) => {
						if (e.key === 'Enter') applyEdit();
						else if (e.key === 'Escape') editing = false;
					}}
				/>
				<Input
					class="embed-edit-input embed-edit-title"
					bind:value={draftTitle}
					aria-label={m.md_embed_edit_title()}
					onkeydown={(e) => {
						if (e.key === 'Enter') applyEdit();
						else if (e.key === 'Escape') editing = false;
					}}
				/>
				<Button variant="ghost" size="xs" class="embed-edit" onclick={applyEdit}
					>{m.md_link_apply()}</Button
				>
				<Button variant="ghost" size="xs" class="embed-edit" onclick={() => (editing = false)}
					>{m.md_link_cancel()}</Button
				>
			</div>
		{/if}
	</div>
{/if}

<style>
	.embed-card-mount {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.75rem 1rem;
		margin-block: 1rem;
		transition: border-color 0.3s;
	}
	.embed-card-mount:hover {
		border-color: var(--ring);
	}
	.embed-card-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.embed-favicon {
		width: 16px;
		height: 16px;
		border-radius: 4px;
		flex: none;
	}
	.embed-favicon-default {
		color: var(--muted-foreground);
	}
	.embed-badge {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.embed-title {
		font-weight: 600;
		line-height: 1.4;
	}
	.embed-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.embed-link {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.8125rem;
		font-family: var(--font-mono, monospace);
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.embed-link:hover {
		color: var(--foreground);
	}
	.embed-load {
		flex: none;
		cursor: pointer;
	}
	/* ── Editor-side in-place edit row ── */
	.embed-edit {
		flex: none;
		cursor: pointer;
	}
	.embed-edit-row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding-top: 0.35rem;
		border-top: 1px dashed var(--border);
	}
	.embed-edit-input {
		flex: 1 1 12rem;
		min-width: 0;
		height: 1.75rem;
		border-radius: var(--radius-sm, 6px);
		border: 1px solid var(--border);
		background: var(--background);
		padding: 0 0.5rem;
		font-size: 0.8125rem;
		color: var(--foreground);
	}
	.embed-edit-input:focus {
		outline: 2px solid var(--ring);
		outline-offset: -1px;
	}
	.embed-edit-title {
		flex: 1 1 8rem;
	}
	/* ── Enriched (metadata-backed) card decorations ──
	   Layers are absolutely positioned and pointer-transparent so they never
	   intercept clicks; the card keeps its static layout as the base state. */
	.embed-card-mount {
		position: relative;
		overflow: hidden;
	}
	.embed-card-mount.embed-enriched {
		padding-right: 4.5rem;
	}
	.embed-tint {
		position: absolute;
		inset: 0;
		background: var(--lang-color);
		opacity: 0.06;
		pointer-events: none;
	}
	.embed-enriched.embed-card-mount,
	.embed-enriched.embed-card-mount:hover {
		border-color: color-mix(in srgb, var(--lang-color) 40%, var(--border));
	}
	.embed-spotlight {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			420px circle at var(--mx, 50%) var(--my, 50%),
			color-mix(in srgb, var(--lang-color) 30%, transparent) 0%,
			transparent 65%
		);
		opacity: 0;
		transition: opacity 0.5s;
		pointer-events: none;
	}
	.embed-enriched:hover .embed-spotlight {
		opacity: 1;
	}
	.embed-avatar {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		object-fit: cover;
	}
	.embed-desc {
		margin: 0;
		font-size: 0.875rem;
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	.embed-chip {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8125rem;
		font-family: var(--font-mono, monospace);
		color: var(--muted-foreground);
	}
	.embed-lang-dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		flex: none;
	}
	.embed-additions {
		color: var(--chart-2, #22c55e);
	}
	.embed-deletions {
		color: var(--chart-5, #ef4444);
	}
	.embed-iframe {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		border: 0;
		border-radius: var(--radius-md);
		margin-block: 1rem;
		opacity: 1;
		transition: opacity 0.2s ease-out;
	}
	/* no widgets.js means no resize handshake: a fixed height for tweets */
	.embed-iframe-tweet {
		height: 550px;
	}
	@media (prefers-reduced-motion: reduce) {
		.embed-iframe,
		.embed-card-mount,
		.embed-link,
		.embed-spotlight {
			transition: none;
		}
		.embed-spotlight {
			display: none;
		}
	}
</style>

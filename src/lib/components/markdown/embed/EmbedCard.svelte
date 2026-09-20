<script lang="ts">
	/**
	 * Embed card component (spec 3.4) — mounted over the placeholder anchors
	 * produced by remark-image-embed. Everything renders from the URL itself:
	 * no data fetch, no third-party script, no request until a facade click
	 * (spec 6). Facades (youtube, bilibili) build their embed source from the
	 * URL and mount a sandboxed iframe only after the explicit click; every
	 * other provider stays a readable link card (tweet's real widget needs a
	 * third-party script — a recorded follow-up).
	 */
	import {
		canonicalHost,
		EMBED_PROVIDER_DOMAINS,
		type EmbedProviderId
	} from '$lib/components/markdown/embed/registry';

	let {
		provider,
		url,
		title
	}: { provider: EmbedProviderId | 'generic'; url: string; title: string } = $props();

	const PROVIDER_LABELS = {
		'gh-repo': 'GitHub 仓库',
		'gh-commit': 'GitHub 提交',
		'gh-pr': 'GitHub PR',
		'gh-issue': 'GitHub Issue',
		'gh-discussion': 'GitHub 讨论',
		'gh-file': 'GitHub 文件',
		'gh-gist': 'GitHub Gist',
		tweet: '推文',
		youtube: 'YouTube',
		bilibili: '哔哩哔哩',
		codesandbox: 'CodeSandbox',
		arxiv: 'arXiv',
		tmdb: 'TMDB',
		bangumi: 'Bangumi',
		'qq-music': 'QQ 音乐',
		'netease-music': '网易云音乐',
		leetcode: 'LeetCode',
		'mx-space': '站内'
	} satisfies Record<EmbedProviderId, string>;
	const label = $derived(provider === 'generic' ? '链接' : PROVIDER_LABELS[provider]);

	function facadeSrc(): string | null {
		if (provider === 'youtube') {
			const id = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1];
			return id ? `https://www.youtube.com/embed/${id}` : null;
		}
		if (provider === 'bilibili') {
			const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
			return bv ? `https://player.bilibili.com/player.html?bvid=${bv}` : null;
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
</script>

{#if loaded && src}
	<iframe
		bind:this={iframeEl}
		tabindex="-1"
		class="embed-iframe"
		{src}
		{title}
		loading="lazy"
		sandbox="allow-scripts allow-same-origin allow-presentation"
		allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
	></iframe>
{:else}
	<div class="embed-card-mount">
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
			<span class="embed-title">{title}</span>
		</div>
		<a class="embed-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
		{#if src}
			<button type="button" class="embed-load" onclick={() => (loaded = true)}>点击加载</button>
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
	}
	.embed-card-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.embed-favicon {
		width: 16px;
		height: 16px;
		border-radius: 4px;
	}
	.embed-favicon-default {
		color: var(--muted-foreground);
		flex: none;
	}
	.embed-badge {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.embed-title {
		font-weight: 600;
	}
	.embed-link {
		font-size: 0.875rem;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.embed-load {
		align-self: flex-start;
		cursor: pointer;
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
	@media (prefers-reduced-motion: reduce) {
		.embed-iframe {
			transition: none;
		}
	}
</style>

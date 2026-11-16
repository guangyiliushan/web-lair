<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { getLocale, getTextDirection, shouldRedirect } from '$lib/paraglide/runtime';
	import { afterNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { siteIconHref } from '$lib/utils/site-icon';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// `site.icon` (Settings → Site) wins when set, else the bundled asset;
	// `?v=` busts the very sticky favicon cache.
	const iconHref = $derived(siteIconHref(data.siteIcon, favicon));

	// Mirror the server-side URL canonicalisation on the client (SvelteKit's
	// documented recipe): the middleware only sees document requests, so a client
	// navigation to an unprefixed URL re-syncs itself here. Locale changes are full
	// document loads on purpose — never `goto()` — so `lang`/`dir` and the rendered
	// tree match; canonical and exempt routes never redirect, so this cannot loop.
	afterNavigate(async () => {
		const decision = await shouldRedirect({ url: window.location.href });
		if (decision.shouldRedirect && decision.redirectUrl) {
			window.location.href = decision.redirectUrl.href;
		}
	});

	onMount(() => {
		themeStore.init();
		// The server writes lang/dir from the request locale; re-assert them from the
		// resolved client locale so a cookie change between SSR and hydration cannot
		// drift the attributes — that mismatch has no console signal.
		document.documentElement.lang = getLocale();
		document.documentElement.dir = getTextDirection();
	});
</script>

<svelte:head>
	<link rel="icon" href={iconHref} />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta property="og:site_name" content={data.siteName} />
</svelte:head>

<Tooltip.Provider>
	<div class="selection:bg-primary/30">
		{@render children()}
	</div>
</Tooltip.Provider>

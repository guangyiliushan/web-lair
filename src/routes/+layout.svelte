<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { getLocale, getTextDirection, shouldRedirect } from '$lib/paraglide/runtime';
	import { afterNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Mirror the server-side URL canonicalisation on the client (the official
	// SvelteKit recipe): the server middleware only redirects document
	// requests, so a client-side navigation to an unprefixed URL has to
	// re-sync itself here. Locale-changing redirects are full document
	// navigations by design — never goto() — so <html lang>/dir, the
	// server-rendered tree and client state all match the new locale. The
	// decision is false for canonical and exempt routes, so this cannot loop.
	afterNavigate(async () => {
		const decision = await shouldRedirect({ url: window.location.href });
		if (decision.shouldRedirect && decision.redirectUrl) {
			window.location.href = decision.redirectUrl.href;
		}
	});

	onMount(() => {
		themeStore.init();
		// The server writes lang/dir from the request's locale; re-assert them
		// from the resolved client locale so the attributes cannot drift if the
		// cookie changed between the SSR response and hydration - that mismatch
		// has no console signal to catch it otherwise.
		document.documentElement.lang = getLocale();
		document.documentElement.dir = getTextDirection();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Tooltip.Provider>
	<div class="selection:bg-primary/30">
		{@render children()}
	</div>
</Tooltip.Provider>

<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { getLocale, getTextDirection } from '$lib/paraglide/runtime';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

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

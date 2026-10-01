<script lang="ts">
	import Header from '$lib/components/layout/Header.svelte';
	import Footer from '$lib/components/layout/Footer.svelte';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="alternate" type="application/rss+xml" href={localizeHref('/rss.xml')} />
</svelte:head>

<div class="flex min-h-screen flex-col selection:bg-primary/30">
	<Header
		auth={data.auth}
		postsData={data.postsData}
		notesData={data.notesData}
		timelineData={data.timelineData}
	/>
	<div class="flex flex-1 pt-24">
		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</div>
	<Footer />
</div>

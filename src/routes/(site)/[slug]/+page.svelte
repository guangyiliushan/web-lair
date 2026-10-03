<script lang="ts">
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { SeoHead } from '$lib/components/seo';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.page.title}</title>
	{#if data.page.description}
		<meta name="description" content={data.page.description} />
	{/if}
</svelte:head>

<SeoHead path={data.seo.path} alternates={data.seo.alternates} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<header class="border-b border-border/50 pb-6">
		<h1 class="text-3xl font-normal">{data.page.title}</h1>
		{#if data.page.description}
			<p class="mt-2 text-sm text-muted-foreground">{data.page.description}</p>
		{/if}
	</header>

	<div class="mt-8">
		<MarkdownRenderer html={data.html} prose />
	</div>
</article>

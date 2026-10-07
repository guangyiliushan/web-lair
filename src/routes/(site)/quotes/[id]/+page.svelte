<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.title}</title>
</svelte:head>

<SeoHead path={`/quotes/${data.row.id}`} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<a
		href={siteHref('/quotes')}
		class="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<IconArrowLeft class="size-3.5" />
		{m.quotes_back()}
	</a>

	<h1 class="sr-only">{m.quotes_title()}</h1>

	<blockquote class="mt-10 border-l-2 border-primary/60 pl-6">
		<IconQuote class="size-5 text-muted-foreground/50" />
		<p class="mt-3 text-xl leading-relaxed">{data.row.content}</p>
		<footer class="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
			{#if data.row.author}
				<span>— {data.row.author}</span>
			{/if}
			{#if data.row.source}
				<span class="italic">《{data.row.source}》</span>
			{/if}
			<span>{data.row.dateLabel}</span>
		</footer>
	</blockquote>
</article>

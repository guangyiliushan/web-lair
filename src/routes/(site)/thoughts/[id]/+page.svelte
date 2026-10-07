<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.title}</title>
</svelte:head>

<SeoHead path={`/thoughts/${data.row.id}`} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<a
		href={siteHref('/thoughts')}
		class="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<IconArrowLeft class="size-3.5" />
		{m.thoughts_back()}
	</a>

	<h1 class="sr-only">{m.thoughts_title()}</h1>

	<div class="mt-10">
		<p class="text-xl leading-relaxed wrap-break-word whitespace-pre-wrap">{data.row.content}</p>
		<span class="mt-6 block text-sm text-muted-foreground">{data.row.dateLabel}</span>
	</div>
</article>

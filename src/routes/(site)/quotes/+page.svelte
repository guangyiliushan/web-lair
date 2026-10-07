<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/quotes" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<div class="min-w-0">
		<h1 id="quotes-heading" class="text-[28px] leading-tight font-medium">{m.quotes_title()}</h1>
		<p class="mt-2 text-sm text-muted-foreground">{m.nav_more_quotes_desc()}</p>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>
	</div>

	{#await data.rows}
		<div class="columns-1 gap-5 sm:columns-2" aria-hidden="true">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton class="mb-5 h-28 w-full break-inside-avoid" />
			{/each}
		</div>
	{:then rows}
		{#if rows.length === 0}
			<p class="text-sm text-muted-foreground">{m.quotes_empty()}</p>
		{:else}
			<div class="columns-1 gap-5 sm:columns-2" role="list" aria-labelledby="quotes-heading">
				{#each rows as row (row.id)}
					<article
						role="listitem"
						class="mb-5 break-inside-avoid rounded-lg border border-border/60 transition-colors hover:border-border hover:bg-muted/30"
					>
						<a href={siteHref(`/quotes/${row.id}`)} class="block p-4">
							<IconQuote class="size-4 text-muted-foreground/60" />
							<p class="mt-2 text-base leading-relaxed wrap-break-word whitespace-pre-wrap">
								{row.content}
							</p>
							<div
								class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
							>
								{#if row.author}
									<span>{row.author}</span>
								{/if}
								{#if row.source}
									<span class="italic">《{row.source}》</span>
								{/if}
								<span>{row.dateLabel}</span>
							</div>
						</a>
					</article>
				{/each}
			</div>
		{/if}
	{/await}
</div>

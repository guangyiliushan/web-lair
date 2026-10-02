<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/posts/categories" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<header>
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			{m.posts_browse()}
		</div>
		<h1 class="text-[28px] leading-tight font-medium">{m.posts_categories_title()}</h1>
		<div class="mt-6 mb-7 h-px w-8 bg-primary/70"></div>
	</header>

	{#if data.categories.length > 0}
		<ul class="min-w-0">
			{#each data.categories as category (category.slug)}
				<li class="list-none">
					<a
						href={siteHref(`/posts/categories/${category.slug}`)}
						class="group -mx-3 flex items-baseline justify-between gap-4 border-b border-foreground/5 px-3 py-3.5 transition-[background] duration-300 ease-out hover:bg-linear-to-r hover:from-transparent hover:via-primary/6 hover:to-transparent"
					>
						<span
							class="min-w-0 truncate text-sm font-normal text-foreground/85 transition-colors duration-200 group-hover:text-primary group-focus-visible:text-primary"
						>
							{category.name}
						</span>
						<span class="shrink-0 text-xs text-muted-foreground/50 tabular-nums">
							{category.total}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">{m.posts_categories_empty()}</p>
	{/if}
</div>

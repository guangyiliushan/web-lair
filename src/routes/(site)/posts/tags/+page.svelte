<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { siteHref } from '$lib/utils/href';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/posts/tags" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<header>
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			Browse
		</div>
		<h1 class="text-[28px] leading-tight font-medium">Tags</h1>
		<div class="mt-6 mb-7 h-px w-8 bg-primary/70"></div>
	</header>

	{#if data.tags.length > 0}
		<ul class="flex min-w-0 flex-wrap gap-2">
			{#each data.tags as tag (tag.slug)}
				<li class="list-none">
					<a
						href={siteHref(`/posts/tags/${tag.slug}`)}
						class="inline-flex items-baseline gap-1.5 rounded-full bg-muted px-3 py-1 text-sm text-foreground/70 transition-colors duration-150 hover:bg-primary/10 hover:text-primary"
					>
						<span>#{tag.name}</span>
						<span class="text-xs text-muted-foreground/50">{tag.total}</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">No tags yet.</p>
	{/if}
</div>

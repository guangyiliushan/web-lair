<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import type { PageServerData } from './$types';

	let { data }: { data: PageServerData } = $props();

	const tag = $derived(data.tag);
	const posts = $derived(data.posts);
</script>

<SeoHead path={`/posts/tags/${tag.slug}`} />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<header>
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			{m.posts_tag_heading()}
		</div>

		<div class="mb-2 flex items-baseline gap-3">
			<span
				class="text-[2.5rem] leading-none font-extralight tracking-tight text-foreground/85 tabular-nums sm:text-[3.5rem]"
			>
				{posts.length}
			</span>
			<span class="text-sm text-muted-foreground">
				{posts.length === 1 ? m.posts_tag_entry() : m.posts_tag_entries()}
			</span>
		</div>

		<h1 class="text-[28px] leading-tight font-medium">#{tag.name}</h1>

		<div class="mt-6 mb-7 h-px w-8 bg-primary/70"></div>
	</header>

	{#if posts.length > 0}
		<ul class="min-w-0">
			{#each posts as post (post.slug)}
				<li class="list-none">
					<a
						href={siteHref(`/posts/${post.slug}`)}
						class="group -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-b border-foreground/5 px-3 py-3.5 transition-[background] duration-300 ease-out hover:bg-linear-to-r hover:from-transparent hover:via-primary/6 hover:to-transparent"
					>
						<span
							class="min-w-0 truncate text-sm font-normal text-foreground/85 transition-colors duration-200 group-hover:text-primary group-focus-visible:text-primary"
						>
							{post.title}
						</span>
						<span class="shrink-0 text-xs whitespace-nowrap text-muted-foreground/40 tabular-nums">
							{post.date}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">{m.posts_tag_empty()}</p>
	{/if}

	<footer class="mt-10 flex justify-center border-t border-foreground/6 pt-6">
		<a
			href={siteHref('/posts/tags')}
			class="text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary"
		>
			{m.posts_tag_all()}
		</a>
	</footer>
</div>

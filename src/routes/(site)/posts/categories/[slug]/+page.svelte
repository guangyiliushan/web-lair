<script lang="ts">
	import type { PageServerData } from './$types';
	import { SeoHead } from '$lib/components/seo';
	import { siteHref } from '$lib/utils/href';

	let { data }: { data: PageServerData } = $props();

	const category = $derived(data.category);
	const totalCount = $derived(data.totalCount);
	const earliestYear = $derived(data.earliestYear);
	const years = $derived(data.years);
	const tags = $derived(data.tags);

	// ── Back to top ──
	function scrollToTop() {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}
</script>

<svelte:head>
	<title>{category.name} - Posts</title>
</svelte:head>

<SeoHead path={`/posts/categories/${category.slug}`} />

<div class="mx-auto mt-14 max-w-3xl px-2 lg:mt-20 lg:px-0 2xl:max-w-4xl [&_header.prose]:mb-20">
	<!-- ══ Header ══ -->
	<header class="text-foreground">
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			Category
		</div>

		<div class="mb-2 flex items-baseline gap-3">
			<span
				class="text-[2.5rem] leading-none font-extralight tracking-tight text-foreground/85 tabular-nums sm:text-[3.5rem]"
			>
				{totalCount}
			</span>
			<span class="text-sm text-muted-foreground">
				articles{earliestYear ? ` · from ${earliestYear}` : ''}
			</span>
		</div>

		<h1 class="text-[28px] leading-tight font-medium">{category.name}</h1>

		<div class="mt-6 mb-7 h-px w-8 bg-primary/70"></div>
	</header>

	<!-- ══ Post list grouped by year ══ -->
	<ul class="min-w-0">
		{#each years as yearGroup, yi (yearGroup.year)}
			{@const totalIndex = years.slice(0, yi).reduce((sum, yg) => sum + yg.posts.length + 1, 0)}

			<!-- Year header -->
			<li
				class="flex items-baseline gap-2.5 pt-5 pb-2 first:pt-1"
				style="--li-index: {totalIndex}; animation-delay: {totalIndex * 50}ms"
			>
				<span
					class="text-[28px] leading-none font-extralight tracking-tight text-foreground/30 tabular-nums"
				>
					{yearGroup.year}
				</span>
				<span class="text-[10px] tracking-wider text-muted-foreground/35">
					{yearGroup.count}
					{yearGroup.count === 1 ? 'entry' : 'entries'}
				</span>
			</li>

			<!-- Post rows -->
			{#each yearGroup.posts as post, pi (post.slug)}
				{@const postIndex = totalIndex + 1 + pi}
				<li class="list-none" style="--li-index: {postIndex}; animation-delay: {postIndex * 50}ms">
					<a
						href={siteHref(`/posts/${post.slug}`)}
						class="group -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-b border-foreground/5 px-3 py-3.5 transition-[background] duration-300 ease-out hover:bg-linear-to-r hover:from-transparent hover:via-primary/6 hover:to-transparent"
					>
						<span
							class="min-w-0 truncate text-sm font-normal text-foreground/85 transition-colors duration-200 group-hover:text-primary"
						>
							{post.title}
						</span>

						<span class="flex shrink-0 items-baseline gap-4 text-xs tabular-nums">
							{#if post.tags.length > 0}
								<span class="whitespace-nowrap">
									{#each post.tags.slice(0, 2) as tagName, ti (tagName)}
										<span class="text-primary">{ti > 0 ? ', ' : ''}#{tagName}</span>
									{/each}
									{#if post.tags.length > 2}
										<span class="text-muted-foreground/40"> +{post.tags.length - 2}</span>
									{/if}
								</span>
							{/if}
							<span class="min-w-24 text-right whitespace-nowrap text-muted-foreground/40"
								>{post.date}</span
							>
						</span>
					</a>
				</li>
			{/each}
		{/each}
	</ul>

	<!-- ══ Tags in this category ══ -->
	{#if tags.length > 0}
		<section class="mt-7 border-t border-foreground/6 pt-4">
			<div class="mb-2.5 text-[10px] font-medium tracking-[3px] text-muted-foreground uppercase">
				Tags in this category
			</div>

			<ul class="flex flex-wrap gap-1.5 p-0">
				{#each tags as tagItem (tagItem.slug)}
					<li>
						<a
							href={siteHref(`/posts/tags/${tagItem.slug}`)}
							class="inline-flex items-baseline rounded-full bg-muted px-2.5 py-0.5 text-xs text-foreground/65 transition-colors duration-150 hover:bg-primary/8 hover:text-primary"
						>
							<span>#{tagItem.name}</span>
							<span class="ml-1 text-muted-foreground/40">{tagItem.count}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- ══ Back to top ══ -->
	<div class="mt-10 flex justify-center border-t border-foreground/6 pt-6 dark:border-foreground/6">
		<button
			onclick={scrollToTop}
			class="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground/85"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				class="size-4 opacity-70"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<circle cx="12" cy="12" r="10" />
				<path d="m16 12-4-4-4 4" />
				<path d="M12 16V8" />
			</svg>
			<span>Back to top</span>
		</button>
	</div>
</div>

<style>
	ul > li {
		animation: timeline-fade-up 0.4s ease-out both;
		animation-delay: calc(var(--li-index, 0) * 50ms);
	}

	@keyframes timeline-fade-up {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>

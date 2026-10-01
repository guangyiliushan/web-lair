<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import * as Pagination from '$lib/components/ui/pagination';
	import { SeoHead } from '$lib/components/seo';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { IconEye, IconHeart, IconArrowLeft, IconArrowRight } from '@tabler/icons-svelte-runes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const pinnedPost = $derived(data.pinnedPost);
	const posts = $derived(data.posts);

	// Paginated pages are self-canonical (P3-b R1-Q5).
	const listPath = $derived(`/posts${data.page > 1 ? `?page=${data.page}` : ''}`);
</script>

<SeoHead path={listPath} />

<div class="mx-auto mt-14 max-w-5xl px-4 lg:mt-20 lg:px-0 2xl:max-w-6xl">
	<div class="min-w-0">
		<!-- Page header -->
		<div class="text-xs font-medium tracking-[4px] text-muted-foreground uppercase">Blog</div>
		<h1 class="mt-2.5 text-3xl font-normal">Posts</h1>

		<!-- Pinned post -->
		{#if pinnedPost}
			<Card.Root
				class="mt-5 rounded-lg border bg-card/50 p-5 transition-all duration-200 hover:-translate-y-px hover:bg-card/70 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] dark:border-white/5 dark:bg-white/4 dark:hover:bg-white/6"
			>
				<a href={localizeHref(`/posts/${pinnedPost.slug}`)} class="block">
					<Card.Header class="p-0">
						<div class="mb-2 text-xs font-medium tracking-[1px] text-primary">Pinned</div>
						<Card.Title class="text-lg font-medium">{pinnedPost.title}</Card.Title>
					</Card.Header>
					<Card.Content class="mt-2 p-0">
						<p class="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
							{pinnedPost.excerpt}
						</p>
					</Card.Content>
					<Card.Footer class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 p-0 text-xs">
						<span class="whitespace-nowrap text-muted-foreground">{pinnedPost.date}</span>
						<span class="text-muted-foreground/40">·</span>
						<span class="text-primary">{pinnedPost.category}</span>
						{#each pinnedPost.tags as tag, i (tag)}
							<span class="text-muted-foreground/40">{i === 0 ? '/' : ','}</span>
							<span class="text-primary">{tag}</span>
						{/each}
					</Card.Footer>
				</a>
				<!-- Stats row -->
				<div
					class="mt-3 flex justify-end gap-2.5 border-t border-dashed border-border pt-2 text-xs text-muted-foreground"
				>
					<span class="flex items-center gap-1">
						<IconEye class="size-3.5" />
						<span>{pinnedPost.views}</span>
					</span>
					<span class="flex items-center gap-1">
						<IconHeart class="size-3.5" />
						<span>{pinnedPost.likes}</span>
					</span>
				</div>
			</Card.Root>
		{/if}

		<!-- Counter -->
		<div class="mt-5 flex items-center justify-between border-b border-border/50 pb-3">
			<span class="text-xs text-muted-foreground">{data.total} posts</span>
		</div>

		<!-- Post list -->
		{#if posts.length > 0}
			<div class="flex flex-col">
				{#each posts as post (post.slug)}
					<a
						href={localizeHref(`/posts/${post.slug}`)}
						class="-mx-4 my-1 block rounded-lg px-4 py-3.5 transition-all duration-200 hover:-translate-y-px hover:bg-card/70 hover:shadow-[0_2px_12px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.03)] dark:hover:bg-white/5"
					>
						<div class="flex items-baseline gap-2">
							<h3 class="text-base font-medium">{post.title}</h3>
						</div>
						{#if post.excerpt}
							<p class="mt-1 line-clamp-1 text-sm leading-normal text-muted-foreground">
								{post.excerpt}
							</p>
						{/if}
						<div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
							<span class="whitespace-nowrap text-muted-foreground">{post.date}</span>
							<span class="text-muted-foreground/40">·</span>
							<span class="text-primary">{post.category}</span>
							{#each post.tags.slice(0, 3) as tag, i (tag)}
								<span class="text-muted-foreground/40">{i === 0 ? '/' : ','}</span>
								<span class="text-primary">{tag}</span>
							{/each}
							{#if post.tags.length > 3}
								<span class="text-muted-foreground tabular-nums">+{post.tags.length - 3}</span>
							{/if}
						</div>
						<!-- Stats -->
						<div
							class="mt-2 flex justify-end gap-2.5 border-t border-dashed border-border pt-2 text-xs text-muted-foreground"
						>
							<span class="flex items-center gap-1">
								<IconEye class="size-3.5" />
								<span>{post.views}</span>
							</span>
							<span class="flex items-center gap-1">
								<IconHeart class="size-3.5" />
								<span>{post.likes}</span>
							</span>
						</div>
					</a>
				{/each}
			</div>
		{:else if !pinnedPost}
			<p class="mt-10 text-sm text-muted-foreground">No posts yet.</p>
		{/if}

		<!-- Pagination -->
		{#if data.totalPages > 1}
			<nav class="mt-20 border-t border-border/40 pt-5" aria-label="Pagination">
				<Pagination.Root count={data.total} perPage={10} page={data.page}>
					<Pagination.Content class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
						<Pagination.Item class="list-none">
							{#if data.page > 1}
								<Button
									variant="ghost"
									href={localizeHref(`/posts?page=${data.page - 1}`)}
									class="inline-flex items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary"
								>
									<IconArrowLeft data-icon="inline-start" class="shrink-0" />
									<span>Previous page</span>
								</Button>
							{:else}
								<Button
									variant="ghost"
									disabled
									class="inline-flex cursor-default items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground/60 uppercase"
								>
									<IconArrowLeft data-icon="inline-start" class="shrink-0" />
									<span>Previous page</span>
								</Button>
							{/if}
						</Pagination.Item>

						<Pagination.Item class="list-none text-center">
							<span aria-hidden="true" class="text-muted-foreground/40">·</span>
						</Pagination.Item>

						<Pagination.Item class="list-none justify-self-end">
							{#if data.page < data.totalPages}
								<Button
									variant="ghost"
									href={localizeHref(`/posts?page=${data.page + 1}`)}
									class="inline-flex items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary"
								>
									<span>Next page</span>
									<IconArrowRight data-icon="inline-end" class="shrink-0" />
								</Button>
							{:else}
								<Button
									variant="ghost"
									disabled
									class="inline-flex cursor-default items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground/60 uppercase"
								>
									<span>Next page</span>
									<IconArrowRight data-icon="inline-end" class="shrink-0" />
								</Button>
							{/if}
						</Pagination.Item>

						<div
							class="col-span-full mt-2 text-center text-xs tracking-[3px] text-muted-foreground uppercase tabular-nums"
						>
							Page {data.page} of {data.totalPages}
						</div>
					</Pagination.Content>
				</Pagination.Root>
			</nav>
		{/if}
	</div>
</div>

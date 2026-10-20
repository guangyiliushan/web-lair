<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import * as Pagination from '$lib/components/ui/pagination';
	import { SeoHead } from '$lib/components/seo';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { POST_SORTS, postListHref, type PostSort } from '$lib/utils/posts-list';
	import {
		IconEye,
		IconHeart,
		IconArrowLeft,
		IconArrowRight,
		IconWriting
	} from '@tabler/icons-svelte-runes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const pinnedPost = $derived(data.pinnedPost);
	const posts = $derived(data.posts);

	const SORT_LABELS = {
		latest: 'Latest',
		oldest: 'Oldest',
		updated: 'Recently updated'
	} satisfies Record<PostSort, string>;

	// Derived from the shared whitelist: adding a sort without a label is a
	// compile error, and the nav can never silently miss a member.
	const SORT_OPTIONS = POST_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }));

	const controlBase =
		'rounded-sm text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
	const controlActive = `${controlBase} font-medium text-foreground underline decoration-foreground/40 underline-offset-4`;
	const controlIdle = `${controlBase} text-muted-foreground hover:text-foreground`;
	const filterBase =
		'flex items-center gap-1.5 rounded-sm text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
	const filterActive = `${filterBase} font-medium text-foreground`;
	const filterIdle = `${filterBase} text-muted-foreground hover:text-foreground`;

	function listHref(sort: PostSort, page = 1): string {
		return localizeHref(postListHref({ sort, page, ai: data.ai ?? undefined }));
	}

	function filterHref(): string {
		return localizeHref(
			postListHref({
				sort: data.sort,
				page: 1,
				ai: data.ai ? undefined : 'non-generated'
			})
		);
	}

	// Default-order URLs stay canonical (page N → same page N). Sort/filter
	// variants emit no canonical at all: page N variant is not page N default,
	// and the noindex already keeps the variant out of the index.
	const canonicalPath = $derived(postListHref({ page: data.page }));
</script>

{#if !data.isVariant}
	<SeoHead path={canonicalPath} />
{/if}

<svelte:head>
	{#if data.isVariant}
		<meta name="robots" content="noindex, follow" />
	{/if}
</svelte:head>

<div class="mx-auto mt-14 max-w-5xl px-4 lg:mt-20 lg:px-0 2xl:max-w-6xl">
	<div class="min-w-0">
		<h1 class="text-3xl font-normal">Posts</h1>

		<!-- Pinned post -->
		{#if pinnedPost}
			<Card.Root
				data-testid="pinned-card"
				class="mt-5 rounded-lg border bg-card/50 p-5 transition-all duration-200 hover:-translate-y-px hover:bg-card/70 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] dark:border-white/5 dark:bg-white/4 dark:hover:bg-white/6"
			>
				<a href={localizeHref(`/posts/${pinnedPost.slug}`)} class="block">
					<Card.Header class="p-0">
						<div class="mb-2 text-xs font-medium tracking-[1px] text-foreground">Pinned</div>
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
						<span class="text-primary-text">{pinnedPost.category}</span>
						{#each pinnedPost.tags as tag, i (tag)}
							<span class="text-muted-foreground/40">{i === 0 ? '/' : ','}</span>
							<span class="text-primary-text">{tag}</span>
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

		<!-- Count reads as metadata on the left; filter + sort own the right side -->
		<div
			class="mt-5 flex flex-col gap-2 border-b border-border/50 pb-3 sm:flex-row sm:items-center sm:justify-between"
		>
			<span data-testid="post-count" class="text-xs text-muted-foreground">{data.total} posts</span>
			<div class="flex flex-wrap items-center gap-3 sm:gap-4">
				<a
					href={filterHref()}
					data-testid="post-ai-filter"
					aria-label={data.ai
						? m.post_provenance_filter_show_all()
						: m.post_provenance_filter_show_only()}
					title="Author-declared writing; AI assistance is allowed"
					class={data.ai ? filterActive : filterIdle}
				>
					<IconWriting class="size-3.5" aria-hidden="true" />
					{m.post_provenance_filter_label()}
				</a>
				<span aria-hidden="true" class="h-3 w-px bg-border"></span>
				<nav
					data-testid="post-sort"
					aria-label="Sort posts"
					class="flex flex-wrap items-center gap-3 sm:gap-4"
				>
					{#each SORT_OPTIONS as option (option.value)}
						{@const isActive = data.sort === option.value}
						<a
							href={listHref(option.value)}
							aria-current={isActive ? 'true' : undefined}
							class={isActive ? controlActive : controlIdle}
						>
							{option.label}
						</a>
					{/each}
				</nav>
			</div>
		</div>

		<!-- Post list -->
		{#if posts.length > 0}
			<div class="flex flex-col" data-testid="post-list">
				{#each posts as post (post.slug)}
					<a
						href={localizeHref(`/posts/${post.slug}`)}
						data-testid="post-list-item"
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
						<div
							data-testid="post-meta"
							class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
						>
							<div
								data-testid="post-meta-info"
								class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
							>
								{#if post.pinned}
									<span
										data-testid="post-pinned-badge"
										class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-foreground uppercase"
									>
										Pinned
									</span>
									<span class="text-muted-foreground/40">·</span>
								{/if}
								{#if data.sort === 'updated' && post.edited && post.updatedDate}
									<span class="whitespace-nowrap text-muted-foreground"
										>Updated {post.updatedDate}</span
									>
								{:else}
									<span class="whitespace-nowrap text-muted-foreground">{post.date}</span>
								{/if}
								<span class="text-muted-foreground/40">·</span>
								<span class="text-primary-text">{post.category}</span>
								{#each post.tags.slice(0, 3) as tag, i (tag)}
									<span class="text-muted-foreground/40">{i === 0 ? '/' : ','}</span>
									<span class="text-primary-text">{tag}</span>
								{/each}
								{#if post.tags.length > 3}
									<span class="text-muted-foreground tabular-nums">+{post.tags.length - 3}</span>
								{/if}
							</div>
							<div
								data-testid="post-engagement"
								class="ml-auto flex shrink-0 items-center gap-2.5 text-muted-foreground"
							>
								<span data-testid="post-views" class="flex items-center gap-1">
									<IconEye class="size-3.5 shrink-0" />
									<span>{post.views}</span>
								</span>
								<span data-testid="post-likes" class="flex items-center gap-1">
									<IconHeart class="size-3.5 shrink-0" />
									<span>{post.likes}</span>
								</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{:else if !pinnedPost}
			<div class="mt-10 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
				<p>{data.ai ? m.post_provenance_filter_empty() : 'No posts yet.'}</p>
				{#if data.ai}
					<a
						href={localizeHref(postListHref({ sort: data.sort }))}
						class="text-primary-text underline underline-offset-4 hover:text-foreground"
					>
						{m.post_provenance_filter_clear()}
					</a>
				{/if}
			</div>
		{/if}

		<!-- Pagination -->
		{#if data.totalPages > 1}
			<nav class="mt-20 border-t border-border/40 pt-5" aria-label="Pagination">
				<Pagination.Root count={data.total} perPage={data.pageSize} page={data.page}>
					<Pagination.Content class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
						<Pagination.Item class="list-none">
							{#if data.page > 1}
								<Button
									variant="ghost"
									href={listHref(data.sort, data.page - 1)}
									class="inline-flex items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary-text"
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
									href={listHref(data.sort, data.page + 1)}
									class="inline-flex items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary-text"
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

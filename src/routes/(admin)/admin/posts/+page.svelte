<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { Separator } from '$lib/components/ui/separator';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';

	let { data }: PageProps = $props();

	const STATUS_LABELS: Record<string, string> = {
		published: m.admin_posts_status_published(),
		draft: m.admin_posts_status_draft(),
		scheduled: m.admin_posts_status_scheduled(),
		trash: m.admin_posts_status_trash()
	};

	const currentCategory = $derived(
		data.categories.find((c) => c.id === data.filters.category)?.name ??
			m.admin_posts_filter_all_categories()
	);

	function queryHref(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			status: data.filters.status || undefined,
			category: data.filters.category || undefined,
			keyword: data.filters.keyword || undefined,
			...patch
		};
		for (const [key, value] of Object.entries(next)) {
			if (value) params.set(key, value);
		}
		params.delete('page');
		const qs = params.toString();
		return `/admin/posts${qs ? `?${qs}` : ''}`;
	}

	function pageHref(target: number): string {
		const params = new SvelteURLSearchParams();
		if (data.filters.status) params.set('status', data.filters.status);
		if (data.filters.category) params.set('category', data.filters.category);
		if (data.filters.keyword) params.set('keyword', data.filters.keyword);
		if (target > 1) params.set('page', String(target));
		const qs = params.toString();
		return `/admin/posts${qs ? `?${qs}` : ''}`;
	}

	const totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));
	const showFrom = $derived(data.totalCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1);
	const showTo = $derived(Math.min(data.totalCount, data.page * data.pageSize));
</script>

<svelte:head>
	<title>{m.admin_posts_title()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<!-- Search and filter toolbar -->
	<div class="relative flex h-10 shrink-0 items-center border-b">
		<form
			class="relative flex h-full min-w-0 flex-1 items-center self-stretch"
			method="GET"
			action="/admin/posts"
		>
			{#if data.filters.status}
				<input type="hidden" name="status" value={data.filters.status} />
			{/if}
			{#if data.filters.category}
				<input type="hidden" name="category" value={data.filters.category} />
			{/if}
			<IconSearch
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="text"
				name="keyword"
				placeholder={m.admin_posts_search_placeholder()}
				class="h-7 w-full border-0 bg-transparent pr-0 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:ring-0"
				value={data.filters.keyword}
			/>
		</form>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="hidden w-28 justify-between text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<span class="truncate">{currentCategory}</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a href={queryHref({ category: undefined })} {...props}
								>{m.admin_posts_filter_all_categories()}</a
							>
						{/snippet}
					</DropdownMenu.Item>
					{#each data.categories as cat (cat.id)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href={queryHref({ category: cat.id })} {...props}>{cat.name}</a>
							{/snippet}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="hidden w-24 justify-center text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<span class="truncate">
							{data.filters.status
								? STATUS_LABELS[data.filters.status]
								: m.admin_posts_filter_all_status()}
						</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a href={queryHref({ status: undefined })} {...props}
								>{m.admin_posts_filter_all_status()}</a
							>
						{/snippet}
					</DropdownMenu.Item>
					{#each Object.entries(STATUS_LABELS) as [value, label] (value)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href={queryHref({ status: value })} {...props}>{label}</a>
							{/snippet}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<!-- Actions column placeholder — aligns with the table's w-20 -->
		<div class="w-20"></div>
		<!-- Separator and refresh button: absolutely positioned, outside the flex layout -->
		<div class="absolute top-0 right-0 flex h-full items-center pr-2">
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton onclick={() => invalidateAll()} />
		</div>
	</div>

	<!-- Posts list -->
	{#if data.posts.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">{m.admin_posts_empty_title()}</h3>
				<p class="text-sm text-muted-foreground">
					{data.filters.keyword || data.filters.status || data.filters.category
						? m.admin_posts_empty_filtered()
						: m.admin_posts_empty_hint()}
				</p>
			</div>
			<div class="mt-4">
				<Button href="/admin/posts/edit">
					<IconPlus data-icon="inline-start" />
					{m.admin_posts_new()}
				</Button>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="table-fixed">
				<Table.Body>
					{#each data.posts as post (post.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 flex-col gap-1">
									<div class="flex min-w-0 items-center gap-2">
										<a
											href="/admin/posts/edit?id={post.id}"
											class="line-clamp-2 block max-w-lg font-medium hover:text-primary lg:line-clamp-none lg:truncate"
										>
											{post.title || m.admin_posts_untitled()}
										</a>
										<Badge variant="outline" class="shrink-0 text-xs">{post.lang}</Badge>
										{#if post.hasDraft}
											<Badge variant="secondary" class="shrink-0 text-xs"
												>{m.admin_posts_unpublished_changes()}</Badge
											>
										{/if}
									</div>
									<!-- Compact-mode meta row: shown below lg -->
									<div
										class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:gap-x-3 xl:hidden"
									>
										<span class="font-mono">{post.categoryName ?? '—'}</span>
										<span class="inline-flex items-center gap-1"
											><IconEye class="size-3" />{post.readCount}</span
										>
										<span class="inline-flex items-center gap-1"
											><IconThumbUp class="size-3" />{post.likeCount}</span
										>
										<span
											>{formatDateTime(new Date(post.updatedAt ?? post.createdAt), {
												dateStyle: 'short'
											})}</span
										>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-44 xl:table-cell">
								<div class="flex items-center gap-3 overflow-hidden text-sm text-muted-foreground">
									<span class="flex items-center gap-1">
										<IconEye class="size-3.5" />
										{post.readCount}
									</span>
									<span class="flex items-center gap-1">
										<IconThumbUp class="size-3.5" />
										{post.likeCount}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-24 xl:table-cell">
								<Badge variant="outline" class="text-xs">{post.categoryName ?? '—'}</Badge>
							</Table.Cell>
							<Table.Cell class="hidden w-20 xl:table-cell">
								<Badge
									variant={post.status === 'published'
										? 'default'
										: post.status === 'trash'
											? 'destructive'
											: 'secondary'}
									class="text-xs"
								>
									{STATUS_LABELS[post.status] ?? post.status}
								</Badge>
							</Table.Cell>
							<Table.Cell class="hidden w-28 text-muted-foreground sm:table-cell">
								{formatDateTime(new Date(post.updatedAt ?? post.createdAt), {
									dateStyle: 'short',
									timeStyle: 'short'
								})}
							</Table.Cell>
							<Table.Cell class="w-20 text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										href="/admin/posts/edit?id={post.id}"
									>
										<IconPencil class="size-4" />
									</Button>
									<!-- Desktop/tablet: three-dot menu -->
									<span class="hidden sm:contents">
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button variant="ghost" size="icon" class="size-8" {...props}>
														<IconDots class="size-4" />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end">
												<DropdownMenu.Group>
													<DropdownMenu.Item>
														{#snippet child({ props })}
															<a href="/admin/posts/edit?id={post.id}" {...props}>
																<IconPencil data-icon="inline-start" />
																{m.admin_common_edit()}
															</a>
														{/snippet}
													</DropdownMenu.Item>
													<DropdownMenu.Item onclick={() => window.open(`/${post.slug}`, '_blank')}>
														<IconExternalLink data-icon="inline-start" />
														{m.admin_posts_open_new_tab()}
													</DropdownMenu.Item>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item disabled title={m.admin_posts_copy_link_hint()}>
														<IconExternalLink data-icon="inline-start" />
														{m.admin_posts_copy_link()}
													</DropdownMenu.Item>
												</DropdownMenu.Group>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</span>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		<!-- Pagination -->
		<div class="flex items-center justify-between text-xs text-muted-foreground">
			<span>
				{m.admin_posts_total({ count: data.totalCount })}{data.totalCount > 0
					? m.admin_posts_showing_range({ from: showFrom, to: showTo })
					: ''}
			</span>
			{#if totalPages > 1}
				<div class="flex items-center gap-2">
					{#if data.page > 1}
						<Button variant="outline" size="sm" href={pageHref(data.page - 1)}
							>{m.admin_common_prev()}</Button
						>
					{/if}
					<span>{data.page} / {totalPages}</span>
					{#if data.page < totalPages}
						<Button variant="outline" size="sm" href={pageHref(data.page + 1)}
							>{m.admin_common_next()}</Button
						>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

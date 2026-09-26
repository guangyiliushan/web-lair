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
		published: '已发布',
		draft: '草稿',
		scheduled: '定时',
		trash: '回收站'
	};

	const currentCategory = $derived(
		data.categories.find((c) => c.id === data.filters.category)?.name ?? '全部分类'
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
	<title>博文管理 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<!-- 搜索和筛选工具栏 -->
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
				placeholder="搜索标题后回车"
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
							<a href={queryHref({ category: undefined })} {...props}>全部分类</a>
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
							{data.filters.status ? STATUS_LABELS[data.filters.status] : '全部状态'}
						</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a href={queryHref({ status: undefined })} {...props}>全部状态</a>
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
		<!-- 操作列占位 — 与表格 w-20 对齐 -->
		<div class="w-20"></div>
		<!-- 分隔符和刷新按钮：绝对定位，不参与 flex 布局 -->
		<div class="absolute top-0 right-0 flex h-full items-center pr-2">
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton onclick={() => invalidateAll()} />
		</div>
	</div>

	<!-- 博文列表 -->
	{#if data.posts.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无博文</h3>
				<p class="text-sm text-muted-foreground">
					{data.filters.keyword || data.filters.status || data.filters.category
						? '没有符合条件的文章，试试清除筛选。'
						: '还没有创建任何博文，点击上方按钮开始创作吧'}
				</p>
			</div>
			<div class="mt-4">
				<Button href="/admin/posts/edit">
					<IconPlus data-icon="inline-start" />
					新建博文
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
											{post.title || '(无标题)'}
										</a>
										<Badge variant="outline" class="shrink-0 text-xs">{post.lang}</Badge>
										{#if post.hasDraft}
											<Badge variant="secondary" class="shrink-0 text-xs">有未发布改动</Badge>
										{/if}
									</div>
									<!-- 紧凑模式元信息行：lg 以下显示 -->
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
									<!-- 桌面/平板：三点菜单 -->
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
																编辑
															</a>
														{/snippet}
													</DropdownMenu.Item>
													<DropdownMenu.Item onclick={() => window.open(`/${post.slug}`, '_blank')}>
														<IconExternalLink data-icon="inline-start" />
														在新窗口打开
													</DropdownMenu.Item>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item disabled title="随读侧路由（P3）">
														<IconExternalLink data-icon="inline-start" />
														复制链接
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

		<!-- 分页 -->
		<div class="flex items-center justify-between text-xs text-muted-foreground">
			<span>
				共 {data.totalCount} 篇{data.totalCount > 0 ? ` · 显示 ${showFrom}–${showTo}` : ''}
			</span>
			{#if totalPages > 1}
				<div class="flex items-center gap-2">
					{#if data.page > 1}
						<Button variant="outline" size="sm" href={pageHref(data.page - 1)}>上一页</Button>
					{/if}
					<span>{data.page} / {totalPages}</span>
					{#if data.page < totalPages}
						<Button variant="outline" size="sm" href={pageHref(data.page + 1)}>下一页</Button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

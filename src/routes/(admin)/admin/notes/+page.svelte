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
	import { noteMoodLabel, NOTE_WEATHER } from '$lib/utils/note-meta';
	import type { PageProps } from './$types';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';

	let { data }: PageProps = $props();

	const STATUS_LABELS: Record<string, string> = {
		published: '已发布',
		draft: '草稿',
		private: '私密',
		scheduled: '定时',
		trash: '回收站'
	};

	/**
	 * Filterable statuses = the server whitelist. `scheduled` stays out until a
	 * scheduling UI writes such rows; offering it used to answer an unfiltered
	 * list while claiming a filter was active (round-7 review finding).
	 */
	const FILTERABLE_STATUSES = ['published', 'draft', 'private', 'trash'] as const;

	const currentTopic = $derived(
		data.topics.find((t) => t.id === data.filters.topic)?.name ?? '全部专栏'
	);

	function weatherLabel(code: number | null): string | null {
		if (code === null || code === undefined) return null;
		return NOTE_WEATHER[code]?.labels['zh-cn'] ?? String(code);
	}

	function queryHref(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			status: data.filters.status || undefined,
			topic: data.filters.topic || undefined,
			keyword: data.filters.keyword || undefined,
			...patch
		};
		for (const [key, value] of Object.entries(next)) {
			if (value) params.set(key, value);
		}
		params.delete('page');
		const qs = params.toString();
		return `/admin/notes${qs ? `?${qs}` : ''}`;
	}

	function pageHref(target: number): string {
		const params = new SvelteURLSearchParams();
		if (data.filters.status) params.set('status', data.filters.status);
		if (data.filters.topic) params.set('topic', data.filters.topic);
		if (data.filters.keyword) params.set('keyword', data.filters.keyword);
		if (target > 1) params.set('page', String(target));
		const qs = params.toString();
		return `/admin/notes${qs ? `?${qs}` : ''}`;
	}

	const totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));
	const showFrom = $derived(data.totalCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1);
	const showTo = $derived(Math.min(data.totalCount, data.page * data.pageSize));
</script>

<svelte:head>
	<title>手记管理 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<!-- 搜索和筛选工具栏 -->
	<div class="relative flex h-10 shrink-0 items-center border-b">
		<form
			class="relative flex h-full min-w-0 flex-1 items-center self-stretch"
			method="GET"
			action="/admin/notes"
		>
			{#if data.filters.status}
				<input type="hidden" name="status" value={data.filters.status} />
			{/if}
			{#if data.filters.topic}
				<input type="hidden" name="topic" value={data.filters.topic} />
			{/if}
			<IconSearch
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="text"
				name="keyword"
				aria-label="搜索标题"
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
						<span class="truncate">{currentTopic}</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a href={queryHref({ topic: undefined })} {...props}>全部专栏</a>
						{/snippet}
					</DropdownMenu.Item>
					{#each data.topics as topic (topic.id)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href={queryHref({ topic: topic.id })} {...props}>{topic.name}</a>
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
							{(FILTERABLE_STATUSES as readonly string[]).includes(data.filters.status)
								? STATUS_LABELS[data.filters.status]
								: '全部状态'}
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
					{#each FILTERABLE_STATUSES as value (value)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href={queryHref({ status: value })} {...props}>{STATUS_LABELS[value]}</a>
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

	<!-- 手记列表 -->
	{#if data.notes.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无手记</h3>
				<p class="text-sm text-muted-foreground">
					{data.filters.keyword || data.filters.status || data.filters.topic
						? '没有符合条件的记录，试试清除筛选。'
						: '还没有创建任何手记，点击上方按钮开始记录吧'}
				</p>
			</div>
			<div class="mt-4">
				<Button href="/admin/notes/edit">
					<IconPlus data-icon="inline-start" />
					新建手记
				</Button>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="table-fixed">
				<Table.Body>
					{#each data.notes as note (note.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 flex-col gap-1">
									<div class="flex min-w-0 items-center gap-2">
										<a
											href="/admin/notes/edit?id={note.id}"
											class="line-clamp-2 block max-w-lg font-medium hover:text-primary lg:line-clamp-none lg:truncate"
										>
											{note.title || '(无标题)'}
										</a>
										<Badge variant="outline" class="shrink-0 text-xs">{note.lang}</Badge>
										{#if note.hasDraft}
											<Badge variant="secondary" class="shrink-0 text-xs">有未发布改动</Badge>
										{/if}
										{#if note.locked}
											<IconLock
												class="size-3.5 shrink-0 text-muted-foreground"
												role="img"
												aria-label="已加密"
											/>
										{/if}
										{#if note.pinned}
											<IconPin
												class="size-3.5 shrink-0 text-primary/70"
												role="img"
												aria-label="已置顶"
											/>
										{/if}
									</div>
									<!-- 紧凑模式元信息行：lg 以下显示 -->
									<div
										class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:gap-x-3 xl:hidden"
									>
										<span class="font-mono">#{note.nid}</span>
										<span class="font-mono">{note.topicName ?? '—'}</span>
										<span class="inline-flex items-center gap-1"
											><IconEye class="size-3" />{note.readCount}</span
										>
										<span class="inline-flex items-center gap-1"
											><IconThumbUp class="size-3" />{note.likeCount}</span
										>
										{#if note.mood}
											<span>{noteMoodLabel(note.mood as never, 'zh-cn')}</span>
										{/if}
										{#if weatherLabel(note.weatherCode)}
											<span>{weatherLabel(note.weatherCode)}</span>
										{/if}
										<span
											>{formatDateTime(new Date(note.updatedAt ?? note.createdAt), {
												dateStyle: 'short'
											})}</span
										>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-16 text-muted-foreground xl:table-cell">
								<span class="font-mono text-xs">#{note.nid}</span>
							</Table.Cell>
							<Table.Cell class="hidden w-36 xl:table-cell">
								<div class="flex items-center gap-3 overflow-hidden text-sm text-muted-foreground">
									<span class="inline-flex items-center gap-1">
										<IconEye class="size-3.5" />
										{note.readCount}
									</span>
									<span class="inline-flex items-center gap-1">
										<IconThumbUp class="size-3.5" />
										{note.likeCount}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-40 xl:table-cell">
								<div class="flex flex-col gap-0.5 text-xs text-muted-foreground">
									<span>{note.mood ? noteMoodLabel(note.mood as never, 'zh-cn') : '—'}</span>
									<span>
										{weatherLabel(note.weatherCode) ?? '—'}{note.temperatureC
											? ` · ${note.temperatureC}°C`
											: ''}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-24 xl:table-cell">
								{#if note.topicName}
									<Badge variant="outline" class="text-xs">{note.topicName}</Badge>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden w-20 xl:table-cell">
								<Badge
									variant={note.status === 'published'
										? 'default'
										: note.status === 'trash'
											? 'destructive'
											: 'secondary'}
									class="text-xs"
								>
									{STATUS_LABELS[note.status] ?? note.status}
								</Badge>
							</Table.Cell>
							<Table.Cell class="hidden w-28 text-muted-foreground sm:table-cell">
								{formatDateTime(new Date(note.updatedAt ?? note.createdAt), {
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
										href="/admin/notes/edit?id={note.id}"
										aria-label="编辑"
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
															<a href="/admin/notes/edit?id={note.id}" {...props}>
																<IconPencil data-icon="inline-start" />
																编辑
															</a>
														{/snippet}
													</DropdownMenu.Item>
													<DropdownMenu.Item
														onclick={() => window.open(`/notes/${note.slug}`, '_blank')}
													>
														<IconExternalLink data-icon="inline-start" />
														在新窗口打开
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

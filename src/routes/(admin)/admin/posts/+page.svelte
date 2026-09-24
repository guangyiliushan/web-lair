<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { Separator } from '$lib/components/ui/separator';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconArrowUpDown from '@tabler/icons-svelte-runes/icons/arrows-up-down';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';

	// 模拟数据 - 实际应从 data.posts 获取
	const posts = [
		{
			id: '1',
			title: 'AI时代的效率悖论：当生产力提升反而带来焦虑',
			slug: 'ai-efficiency-paradox',
			status: 'published',
			category: 'Experience',
			tags: ['AI', '效率', '思考'],
			views: 1651,
			comments: 10,
			likes: 89,
			updatedAt: '1个月前'
		},
		{
			id: '2',
			title: 'AI 时代的重构方式：从 RFC 到五个 Plan',
			slug: 'ai-reconstruction-rfc-plan',
			status: 'published',
			category: 'Programming',
			tags: ['AI', 'RFC', '架构'],
			views: 1402,
			comments: 19,
			likes: 156,
			updatedAt: '29天前'
		},
		{
			id: '3',
			title: '记 LobeHub 的性能和 DX 优化',
			slug: 'lobehub-performance-dx',
			status: 'published',
			category: 'Technology',
			tags: ['React', '性能', 'DX'],
			views: 3193,
			comments: 30,
			likes: 234,
			updatedAt: '3个月前'
		},
		{
			id: '4',
			title: '我是如何使用 AI 辅助创作的',
			slug: 'ai-assisted-creation',
			status: 'published',
			category: 'Technology',
			tags: ['AI', '创作', '工具'],
			views: 1972,
			comments: 15,
			likes: 178,
			updatedAt: '3个月前'
		},
		{
			id: '5',
			title: 'Better Auth 的多租户用户鉴权的构想',
			slug: 'better-auth-multi-tenant',
			status: 'published',
			category: 'Technology',
			tags: ['Auth', '多租户', '架构'],
			views: 1383,
			comments: 16,
			likes: 145,
			updatedAt: '4个月前'
		},
		{
			id: '6',
			title: '写在离开 Folo 之后',
			slug: 'after-leaving-folo',
			status: 'published',
			category: 'Experience',
			tags: ['职业', '反思', '成长'],
			views: 685,
			comments: 9,
			likes: 67,
			updatedAt: '4个月前'
		},
		{
			id: '7',
			title: '回头看见自己',
			slug: 'looking-back-at-myself',
			status: 'published',
			category: 'Experience',
			tags: ['成长', '反思'],
			views: 10155,
			comments: 117,
			likes: 892,
			updatedAt: '4个月前'
		},
		{
			id: '8',
			title: 'TailwindCSS v4 全新颜色系统与主题切换',
			slug: 'tailwindcss-v4-colors',
			status: 'published',
			category: 'Technology',
			tags: ['TailwindCSS', 'CSS', '主题'],
			views: 3180,
			comments: 28,
			likes: 267,
			updatedAt: '8个月前'
		}
	];

	let searchQuery = $state('');
	let selectedStatus = $state('all');
	let selectedIds = $state<string[]>([]);

	const filteredPosts = $derived(
		posts.filter((post) => {
			const matchesSearch = post.title.toLowerCase().includes(searchQuery.toLowerCase());
			const matchesStatus = selectedStatus === 'all' || post.status === selectedStatus;
			return matchesSearch && matchesStatus;
		})
	);

	const allSelected = $derived(
		filteredPosts.length > 0 && selectedIds.length === filteredPosts.length
	);

	function toggleSelectAll() {
		if (allSelected) {
			selectedIds = [];
		} else {
			selectedIds = filteredPosts.map((p) => p.id);
		}
	}

	function toggleSelect(id: string) {
		if (selectedIds.includes(id)) {
			selectedIds = selectedIds.filter((i) => i !== id);
		} else {
			selectedIds = [...selectedIds, id];
		}
	}
</script>

<svelte:head>
	<title>博文管理 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<!-- 搜索和筛选工具栏 -->
	<div class="relative flex h-10 shrink-0 items-center border-b">
		<label
			class="hidden w-10 shrink-0 cursor-pointer items-center justify-center pl-2 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
			title="全选"
			aria-label="全选"
		>
			<input
				type="checkbox"
				class="size-4 rounded border-border bg-transparent"
				checked={allSelected}
				onchange={toggleSelectAll}
			/>
		</label>
		<form
			class="relative flex h-full min-w-0 flex-1 items-center self-stretch"
			onsubmit={(e) => e.preventDefault()}
		>
			<IconSearch
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="text"
				placeholder="搜索标题或正文"
				class="h-7 w-full border-0 bg-transparent pr-0 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:ring-0"
				bind:value={searchQuery}
			/>
		</form>
		<!-- 数据列占位 — 与表格 w-44 对齐 -->
		<div class="hidden w-44 xl:block"></div>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="hidden w-24 justify-between text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<span class="truncate">全部分类</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>全部分类</DropdownMenu.Item>
					<DropdownMenu.Item>Technology</DropdownMenu.Item>
					<DropdownMenu.Item>Programming</DropdownMenu.Item>
					<DropdownMenu.Item>Experience</DropdownMenu.Item>
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
						class="hidden w-28 justify-center text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<IconArrowUpDown class="size-3.5" />
						<span class="truncate">创建时间</span>
						<IconArrowDown class="size-3" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>创建时间</DropdownMenu.Item>
					<DropdownMenu.Item>更新时间</DropdownMenu.Item>
					<DropdownMenu.Item>阅读量</DropdownMenu.Item>
					<DropdownMenu.Item>点赞数</DropdownMenu.Item>
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<!-- 操作列占位 — 与表格 w-20 对齐 -->
		<div class="w-20"></div>
		<!-- 分隔符和刷新按钮：绝对定位，不参与 flex 布局 -->
		<div class="absolute top-0 right-0 flex h-full items-center pr-2">
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton
				onclick={() => {
					/* TODO: refresh data */
				}}
			/>
		</div>
	</div>

	<!-- 博文列表 -->
	{#if filteredPosts.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无博文</h3>
				<p class="text-sm text-muted-foreground">还没有创建任何博文，点击上方按钮开始创作吧</p>
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
					{#each filteredPosts as post (post.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="hidden w-10 sm:table-cell">
								<input
									type="checkbox"
									class="size-4 rounded border-border bg-transparent"
									checked={selectedIds.includes(post.id)}
									onchange={() => toggleSelect(post.id)}
								/>
							</Table.Cell>
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 flex-col gap-1">
									<a
										href="/admin/posts/edit?id={post.id}"
										class="line-clamp-2 block max-w-lg font-medium hover:text-primary lg:line-clamp-none lg:truncate"
									>
										{post.title}
									</a>
									<!-- 紧凑模式元信息行：lg 以下显示，sm 以下含时间 -->
									<div
										class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:gap-x-3 xl:hidden"
									>
										<span class="font-mono">{post.category}</span>
										<span class="inline-flex items-center gap-1"
											><IconEye class="size-3" />{post.views}</span
										>
										<span class="inline-flex items-center gap-1"
											><IconMessage class="size-3" />{post.comments}</span
										>
										<span class="inline-flex items-center gap-1"
											><IconThumbUp class="size-3" />{post.likes}</span
										>
										<span class="sm:hidden">{post.updatedAt}</span>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-44 xl:table-cell">
								<div class="flex items-center gap-3 overflow-hidden text-sm text-muted-foreground">
									<span class="flex items-center gap-1">
										<IconEye class="size-3.5" />
										{post.views}
									</span>
									<span class="flex items-center gap-1">
										<IconMessage class="size-3.5" />
										{post.comments}
									</span>
									<span class="flex items-center gap-1">
										<IconThumbUp class="size-3.5" />
										{post.likes}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-24 xl:table-cell">
								<Badge variant="outline" class="text-xs">{post.category}</Badge>
							</Table.Cell>
							<Table.Cell class="hidden w-28 text-muted-foreground sm:table-cell">
								{post.updatedAt}
							</Table.Cell>
							<Table.Cell class="w-20 text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										onclick={() => window.open(`/${post.slug}`, '_blank')}
									>
										<IconExternalLink class="size-4" />
									</Button>
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
														<DropdownMenu.Shortcut>⌘↵</DropdownMenu.Shortcut>
													</DropdownMenu.Item>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.CheckboxItem disabled checked={post.status === 'published'}>
													已发布
												</DropdownMenu.CheckboxItem>
												<DropdownMenu.CheckboxItem disabled checked={false}>
													<IconPin data-icon="inline-start" />
													置顶
												</DropdownMenu.CheckboxItem>
												<DropdownMenu.Sub>
													<DropdownMenu.SubTrigger disabled>修改分类</DropdownMenu.SubTrigger>
													<DropdownMenu.SubContent>
														<DropdownMenu.Item>Technology</DropdownMenu.Item>
														<DropdownMenu.Item>Programming</DropdownMenu.Item>
														<DropdownMenu.Item>Experience</DropdownMenu.Item>
													</DropdownMenu.SubContent>
												</DropdownMenu.Sub>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item disabled title="即将推出">
														<IconCopy data-icon="inline-start" />
														复制链接
													</DropdownMenu.Item>
													<DropdownMenu.Item disabled title="即将推出">
														<IconHash data-icon="inline-start" />
														复制 ID
													</DropdownMenu.Item>
													<DropdownMenu.Item disabled title="即将推出">复制 slug</DropdownMenu.Item>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item variant="destructive" disabled title="即将推出">
														<IconTrash data-icon="inline-start" />
														删除
														<DropdownMenu.Shortcut>⌫</DropdownMenu.Shortcut>
													</DropdownMenu.Item>
												</DropdownMenu.Group>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</span>
									<!-- 移动端：删除按钮替代三点菜单 -->
									<Button
										variant="ghost"
										size="icon"
										class="size-8 sm:hidden"
										aria-label="删除"
										disabled
									>
										<IconTrash class="size-4" />
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

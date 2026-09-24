<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Empty } from '$lib/components/ui/empty';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';

	interface Topic {
		id: string;
		name: string;
		slug: string;
		description: string;
		noteCount: number;
	}

	const topics: Topic[] = [
		{
			id: '1',
			name: '技术思考',
			slug: 'tech-thoughts',
			description: '关于技术与未来的思考与记录',
			noteCount: 12
		},
		{
			id: '2',
			name: '生活随笔',
			slug: 'life-essays',
			description: '日常生活中的点滴感悟',
			noteCount: 5
		},
		{ id: '3', name: '旅行', slug: 'travel', description: '世界各地的旅行见闻', noteCount: 3 }
	];

	let selectedTopicId = $state<string | null>(page.url.searchParams.get('id'));

	function selectTopic(id: string) {
		selectedTopicId = id;
		goto(`?id=${id}`, { replaceState: true });
	}

	function backToTopicList() {
		selectedTopicId = null;
		goto('.', { replaceState: true });
	}

	const selectedTopic = $derived(topics.find((t) => t.id === selectedTopicId) ?? null);

	/** Extract first 2 characters from topic name for avatar display */
	function avatarText(name: string): string {
		return name.slice(0, 2);
	}
</script>

<svelte:head>
	<title>专栏管理 - Lair Admin</title>
</svelte:head>

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if selectedTopic}
		{@const topic = selectedTopic}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					class="size-8"
					onclick={backToTopicList}
					aria-label="返回列表"
				>
					<IconArrowLeft data-icon="inline-start" />
				</Button>
				<span class="text-sm font-medium">专栏详情</span>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<Button variant="outline" size="sm">
					<IconPencil data-icon="inline-start" />编辑
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
				>
					<IconTrash data-icon="inline-start" />删除
				</Button>
			</div>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			<section class="mb-6 rounded border bg-muted/50 p-4">
				<div class="flex items-start gap-4">
					<div
						class="flex size-14 shrink-0 items-center justify-center rounded bg-muted text-lg font-semibold"
					>
						{avatarText(topic.name)}
					</div>
					<div class="min-w-0 flex-1">
						<h3 class="truncate text-lg font-semibold">{topic.name}</h3>
						<p class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
							<IconHash class="size-3" />{topic.slug}
						</p>
						<p class="mt-3 text-sm text-muted-foreground">{topic.description}</p>
					</div>
				</div>
			</section>
			<section>
				<div class="mb-3 flex items-center justify-between">
					<h3 class="text-sm font-medium">
						包含的手记
						<span class="ml-1 text-xs text-muted-foreground">({topic.noteCount})</span>
					</h3>
					<Button size="sm">
						<IconPlus data-icon="inline-start" />添加
					</Button>
				</div>
				{#if topic.noteCount === 0}
					<p
						class="rounded border border-dashed bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground"
					>
						暂无手记。
					</p>
				{:else}
					<p class="rounded border bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
						{topic.noteCount} 篇手记来自此专栏
					</p>
				{/if}
			</section>
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<IconHash class="size-4 shrink-0 text-muted-foreground" />
				<h2 class="truncate text-sm font-semibold">专栏列表</h2>
				<span class="text-xs text-muted-foreground tabular-nums">{topics.length} 个</span>
			</div>
			<Button size="sm" variant="outline">
				<IconPlus data-icon="inline-start" />新建
			</Button>
		</div>
		<div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-4 text-xs">
			<input
				type="checkbox"
				class="size-4 rounded border-border bg-transparent"
				aria-label="全选当前页"
			/>
			<span class="text-muted-foreground">全选当前页</span>
			<button
				class="ml-auto inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
				disabled
				type="button"
			>
				<IconTrash class="size-3.5" />删除所选
			</button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if topics.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">暂无专栏</h3>
						<p class="text-sm text-muted-foreground">创建专栏来归类你的手记</p>
					</div>
				</Empty>
			{:else}
				{#each topics as topic (topic.id)}
					<button
						type="button"
						class={cn(
							'grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
							selectedTopicId === topic.id && 'bg-muted/50'
						)}
						onclick={() => selectTopic(topic.id)}
					>
						<input
							type="checkbox"
							class="size-4 rounded border-border bg-transparent"
							aria-label="选择专栏「{topic.name}」"
							onclick={(e) => e.stopPropagation()}
						/>
						<div class="flex min-w-0 items-center gap-3">
							<div
								class="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold"
							>
								{avatarText(topic.name)}
							</div>
							<div class="min-w-0 flex-1">
								<h3 class="truncate text-sm font-medium">{topic.name}</h3>
								<p
									class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground"
								>
									<IconHash class="size-3 shrink-0" />{topic.slug}
								</p>
							</div>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root>
		<!-- ===== 左侧：专栏列表 ===== -->
		<MasterDetail.Pane side="master" class="flex-1 lg:max-w-[340px] xl:max-w-[380px]">
			<MasterDetail.Header icon={IconHash} title="专栏列表" count={topics.length}>
				<Button size="sm" variant="outline">
					<IconPlus data-icon="inline-start" />
					新建
				</Button>
			</MasterDetail.Header>

			<!-- 全选操作栏 -->
			<div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-4 text-xs">
				<input
					type="checkbox"
					class="size-4 rounded border-border bg-transparent"
					aria-label="全选当前页"
				/>
				<span class="text-muted-foreground">全选当前页</span>
				<button
					class="ml-auto inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
					disabled
					type="button"
				>
					<IconTrash class="size-3.5" />
					删除所选
				</button>
			</div>

			<MasterDetail.List>
				{#if topics.length === 0}
					<Empty class="py-12">
						<div class="flex flex-col items-center gap-1">
							<h3 class="text-lg font-semibold tracking-tight">暂无专栏</h3>
							<p class="text-sm text-muted-foreground">创建专栏来归类你的手记</p>
						</div>
					</Empty>
				{:else}
					<div>
						{#each topics as topic (topic.id)}
							<MasterDetail.Item
								selected={selectedTopicId === topic.id}
								onclick={() => selectTopic(topic.id)}
								class="grid grid-cols-[auto_minmax(0,1fr)]"
							>
								<input
									type="checkbox"
									class="size-4 rounded border-border bg-transparent"
									aria-label="选择专栏「{topic.name}」"
									onclick={(e) => e.stopPropagation()}
								/>
								<div class="flex min-w-0 items-center gap-3">
									<div
										class="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold"
									>
										{avatarText(topic.name)}
									</div>
									<div class="min-w-0 flex-1">
										<h3 class="truncate text-sm font-medium">{topic.name}</h3>
										<p
											class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground"
										>
											<IconHash class="size-3 shrink-0" />
											{topic.slug}
										</p>
									</div>
								</div>
							</MasterDetail.Item>
						{/each}
					</div>
				{/if}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- ===== 右侧：专栏详情 ===== -->
		<MasterDetail.Pane side="detail" class="bg-surface-card hidden lg:flex">
			{#if selectedTopic}
				{@const topic = selectedTopic}
				<!-- 详情页头 -->
				<MasterDetail.Header title="专栏详情">
					<Button
						variant="ghost"
						size="icon"
						class="size-8 lg:hidden"
						onclick={() => (selectedTopicId = null)}
						aria-label="返回列表"
					>
						<IconArrowLeft data-icon="inline-start" />
					</Button>
					<Button variant="outline" size="sm">
						<IconPencil data-icon="inline-start" />
						编辑
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
					>
						<IconTrash data-icon="inline-start" />
						删除
					</Button>
				</MasterDetail.Header>

				<!-- 详情内容区 -->
				<div class="min-h-0 flex-1 overflow-auto p-5">
					<!-- 基本信息卡片 -->
					<section class="mb-6 rounded border bg-muted/50 p-4">
						<div class="flex items-start gap-4">
							<div
								class="flex size-14 shrink-0 items-center justify-center rounded bg-muted text-lg font-semibold"
							>
								{avatarText(topic.name)}
							</div>
							<div class="min-w-0 flex-1">
								<h3 class="truncate text-lg font-semibold">{topic.name}</h3>
								<p
									class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
								>
									<IconHash class="size-3" />
									{topic.slug}
								</p>
								<p class="mt-3 text-sm text-muted-foreground">{topic.description}</p>
							</div>
						</div>
					</section>

					<!-- 包含的手记 -->
					<section>
						<div class="mb-3 flex items-center justify-between">
							<h3 class="text-sm font-medium">
								包含的手记
								<span class="ml-1 text-xs text-muted-foreground">({topic.noteCount})</span>
							</h3>
							<Button size="sm">
								<IconPlus data-icon="inline-start" />
								添加
							</Button>
						</div>
						{#if topic.noteCount === 0}
							<p
								class="rounded border border-dashed bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground"
							>
								暂无手记。
							</p>
						{:else}
							<p
								class="rounded border bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground"
							>
								{topic.noteCount} 篇手记来自此专栏
							</p>
						{/if}
					</section>
				</div>
			{:else}
				<!-- 未选择时的占位 -->
				<div class="flex flex-1 items-center justify-center p-8">
					<div class="flex flex-col items-center gap-2 text-center">
						<IconHash class="size-10 text-muted-foreground/40" />
						<h3 class="text-lg font-semibold tracking-tight">选择一个专栏</h3>
						<p class="text-sm text-muted-foreground">从左侧列表中选择专栏以查看详情</p>
					</div>
				</div>
			{/if}
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

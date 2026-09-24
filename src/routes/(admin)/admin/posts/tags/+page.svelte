<script lang="ts">
	import type { PageData } from './$types';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Empty } from '$lib/components/ui/empty';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconInfo from '@tabler/icons-svelte-runes/icons/info-circle';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';

	let { data }: { data: PageData } = $props();

	let selectedId = $state<string | null>(page.url.searchParams.get('id'));

	function selectTag(id: string) {
		selectedId = id;
		goto(`?id=${id}`, { replaceState: true });
	}

	function backToList() {
		selectedId = null;
		goto('.', { replaceState: true });
	}

	const selectedTag = $derived(data.tags.find((t) => t.id === selectedId) ?? null);
</script>

<svelte:head>
	<title>标签管理 - Lair Admin</title>
</svelte:head>

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if selectedTag}
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<Button variant="ghost" size="icon" class="size-8" onclick={backToList} aria-label="返回列表">
				<IconArrowLeft data-icon="inline-start" />
			</Button>
			<span class="text-sm font-medium">标签详情</span>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			<section class="mb-6 flex items-start gap-4 rounded-lg border p-4">
				<div
					class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
				>
					<IconTag class="size-6" />
				</div>
				<div class="min-w-0">
					<h3 class="truncate text-lg font-semibold">{selectedTag.name}</h3>
					<p class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
						<IconHash class="size-3" />{selectedTag.slug}
					</p>
					<div
						class="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground"
					>
						<IconInfo class="mt-px size-3.5 shrink-0" />
						<span>标签随文章编辑管理，在此处仅可查看。编辑文章时可添加或移除标签。</span>
					</div>
				</div>
			</section>
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<IconTag class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="truncate text-sm font-semibold">分类与标签</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">{data.tags.length} 个</span>
		</div>
		<div class="border-b px-4 py-2">
			<h3 class="text-xs font-medium text-muted-foreground uppercase">标签</h3>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.tags.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">暂无标签</p>
					<p class="text-xs text-muted-foreground">标签随文章创建自动生成</p>
				</Empty>
			{:else}
				{#each data.tags as tag (tag.id)}
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
							selectedId === tag.id && 'bg-muted/50'
						)}
						onclick={() => selectTag(tag.id)}
					>
						<IconTag class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h4 class="truncate text-sm font-medium">{tag.name}</h4>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />{tag.slug}
							</p>
						</div>
						<Badge variant="outline" class="text-xs">标签</Badge>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root class="h-[calc(100vh-10rem)]">
		<!-- 侧边栏：标签列表 -->
		<MasterDetail.Pane side="master" class="w-80 shrink-0">
			<MasterDetail.Header icon={IconTag} title="分类与标签" count={data.tags.length} />
			<MasterDetail.List>
				<div class="border-b px-4 py-2">
					<h3 class="text-xs font-medium text-muted-foreground uppercase">标签</h3>
				</div>
				{#if data.tags.length === 0}
					<Empty class="py-8">
						<p class="text-sm text-muted-foreground">暂无标签</p>
						<p class="text-xs text-muted-foreground">标签随文章创建自动生成</p>
					</Empty>
				{:else}
					{#each data.tags as tag (tag.id)}
						<MasterDetail.Item selected={selectedId === tag.id} onclick={() => selectTag(tag.id)}>
							<IconTag class="size-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<h4 class="truncate text-sm font-medium">{tag.name}</h4>
								<p
									class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
								>
									<IconHash class="size-3 shrink-0" />
									{tag.slug}
								</p>
							</div>
							<Badge variant="outline" class="text-xs">标签</Badge>
						</MasterDetail.Item>
					{/each}
				{/if}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- 主面板：标签详情（只读） -->
		<MasterDetail.Pane side="detail">
			{#if selectedTag}
				<MasterDetail.Header title="标签详情" />
				<div class="flex-1 overflow-y-auto p-5">
					<section class="mb-6 flex items-start gap-4 rounded-lg border p-4">
						<div
							class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<IconTag class="size-6" />
						</div>
						<div class="min-w-0">
							<h3 class="truncate text-lg font-semibold">{selectedTag.name}</h3>
							<p
								class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3" />
								{selectedTag.slug}
							</p>
							<div
								class="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground"
							>
								<IconInfo class="mt-px size-3.5 shrink-0" />
								<span>标签随文章编辑管理，在此处仅可查看。编辑文章时可添加或移除标签。</span>
							</div>
						</div>
					</section>
				</div>
			{:else}
				<div class="flex flex-1 items-center justify-center">
					<Empty>
						<div class="flex flex-col items-center gap-1">
							<IconTag class="size-8 text-muted-foreground/40" />
							<h3 class="text-lg font-semibold tracking-tight">选择标签</h3>
							<p class="text-sm text-muted-foreground">从左侧选择一个标签查看详情</p>
						</div>
					</Empty>
				</div>
			{/if}
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

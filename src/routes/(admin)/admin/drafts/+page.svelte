<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Empty } from '$lib/components/ui/empty';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconBook from '@tabler/icons-svelte-runes/icons/book';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconRestore from '@tabler/icons-svelte-runes/icons/restore';
	import IconGitCompare from '@tabler/icons-svelte-runes/icons/git-compare';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	interface DraftVersion {
		id: number;
		label: string;
		title: string;
		time: string;
		wordDiff?: string;
	}

	interface Draft {
		id: string;
		title: string;
		type: 'note' | 'page' | 'post';
		status: 'new' | 'editing';
		editor: string;
		version: number;
		updatedAt: string;
		versions: DraftVersion[];
	}

	const drafts: Draft[] = [
		{
			id: '1', title: '记录 2026 年第 198 天', type: 'note', status: 'new', editor: 'lexical', version: 1, updatedAt: '3小时前',
			versions: [{ id: 1, label: '当前', title: '记录 2026 年第 198 天', time: '3小时前' }]
		},
		{
			id: '2', title: '无标题', type: 'page', status: 'new', editor: 'lexical', version: 1, updatedAt: '3小时前',
			versions: [{ id: 1, label: '当前', title: '无标题', time: '3小时前' }]
		},
		{
			id: '3', title: '无标题', type: 'post', status: 'editing', editor: 'lexical', version: 44, updatedAt: '3小时前',
			versions: [
				{ id: 44, label: '当前', title: '无标题', time: '3小时前' },
				{ id: 43, label: '增量', title: '无标题', time: '4小时前', wordDiff: '-2648 字' },
				{ id: 42, label: '增量', title: '无标题', time: '4天前' },
				{ id: 41, label: '全量', title: '无标题', time: '4天前' },
				{ id: 40, label: '增量', title: '无标题', time: '4天前' },
			]
		},
	];

	let searchQuery = $state('');
	let selectedType = $state('all');
	let selectedDraftId = $state<string | null>(null);

	const typeFilters = ['all', 'post', 'note', 'page'] as const;
	const typeLabels: Record<string, string> = { all: '全部', post: '文章', note: '手记', page: '页面' };

	const filteredDrafts = $derived(
		drafts.filter((d) => {
			const matchType = selectedType === 'all' || d.type === selectedType;
			const matchSearch = d.title.toLowerCase().includes(searchQuery.toLowerCase());
			return matchType && matchSearch;
		})
	);

	const selectedDraft = $derived(drafts.find((d) => d.id === selectedDraftId) ?? null);

	const typeConfig: Record<string, { icon: typeof IconBook; class: string }> = {
		note: { icon: IconBook, class: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300' },
		page: { icon: IconFileText, class: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300' },
		post: { icon: IconArticle, class: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300' },
	};

	const statusLabels: Record<string, string> = { new: '新建', editing: '编辑中' };

	function selectDraft(id: string) {
		selectedDraftId = id;
	}
</script>

<svelte:head>
	<title>草稿箱 - Lair Admin</title>
</svelte:head>

<MasterDetail.Root>
	<!-- ===== 左侧：草稿列表（侧边栏） ===== -->
	<MasterDetail.Pane side="master" class="flex-1 lg:max-w-[340px] xl:max-w-[380px]">
		<!-- 工具栏：搜索 -->
		<div class="flex h-10 shrink-0 items-center border-b pl-2">
			<form class="relative flex h-full min-w-0 flex-1 items-center self-stretch" onsubmit={(e) => e.preventDefault()}>
				<IconSearch class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input type="text" aria-label="搜索标题或正文" placeholder="搜索标题或正文" class="h-7 w-full border-0 bg-transparent pl-8 pr-0 text-xs outline-none placeholder:text-muted-foreground focus:ring-0" bind:value={searchQuery} />
			</form>
		</div>

		<!-- 类型筛选标签 -->
		<div class="flex flex-wrap gap-2 border-b px-4 py-3">
			{#each typeFilters as t (t)}
				<button
					type="button"
					class="rounded border px-2.5 py-1 text-xs transition-colors {selectedType === t
						? 'border-foreground bg-foreground text-background'
						: 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}"
					onclick={() => (selectedType = t)}
				>
					{typeLabels[t]}
				</button>
			{/each}
		</div>

		<!-- 草稿列表 -->
		<MasterDetail.List>
			{#if filteredDrafts.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">暂无草稿</h3>
						<p class="text-sm text-muted-foreground">还没有任何草稿内容</p>
					</div>
				</Empty>
			{:else}
				<div class="divide-y divide-border">
					{#each filteredDrafts as draft (draft.id)}
						{@const cfg = typeConfig[draft.type]}
						<MasterDetail.Item
							selected={selectedDraftId === draft.id}
							onclick={() => selectDraft(draft.id)}
							class="grid grid-cols-[auto_minmax(0,1fr)] border-b-0"
						>
							<!-- 选择框 -->
							<input type="checkbox" class="mt-1 size-4 rounded border-border bg-transparent" onclick={(e) => e.stopPropagation()} />
							<div class="flex min-w-0 items-start gap-3">
								<span class="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-xs border px-2 py-1 text-xs font-medium {cfg.class}">
									<cfg.icon class="size-3" />
									{typeLabels[draft.type]}
								</span>
								<div class="min-w-0 flex-1">
									<div class="flex min-w-0 items-center gap-2">
										<h3 class="truncate text-sm font-medium">{draft.title}</h3>
										<span class="shrink-0 text-xs tabular-nums text-muted-foreground">v{draft.version}</span>
									</div>
									<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										<span>{statusLabels[draft.status]}</span>
										<span>{draft.editor}</span>
										<time>{draft.updatedAt}</time>
									</div>
								</div>
							</div>
						</MasterDetail.Item>
					{/each}
				</div>
			{/if}
		</MasterDetail.List>
	</MasterDetail.Pane>

	<!-- ===== 右侧：草稿详情（主界面） ===== -->
	<MasterDetail.Pane side="detail" class="hidden bg-surface-card lg:flex">
		{#if selectedDraft}
			{@const sd = selectedDraft}
			<!-- 详情页头 -->
			<MasterDetail.Header title={sd.title}>
				<Button variant="outline" size="icon" class="size-8 lg:hidden" onclick={() => (selectedDraftId = null)} aria-label="返回列表">
					<IconX data-icon="inline-start" />
				</Button>
				<Button variant="outline" size="sm" href="/admin/drafts/{sd.id}/edit">
					<IconPencil data-icon="inline-start" />
					编辑
				</Button>
				<Button variant="outline" size="sm" class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive">
					<IconTrash data-icon="inline-start" />
					删除
				</Button>
			</MasterDetail.Header>

			<!-- 详情内容区：版本列表 + 对比预览 -->
			<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
				<!-- 版本列表 -->
				<aside class="min-h-0 border-b lg:border-b-0 lg:border-r">
					<div class="flex h-10 items-center gap-2 border-b px-4 text-sm font-medium">
						<IconGitCompare class="size-4" />
						版本列表
						<span class="text-xs font-normal text-muted-foreground">({sd.versions.length})</span>
					</div>
					<div class="min-h-0 overflow-auto lg:max-h-[calc(100%-2.5rem)]">
						{#each sd.versions as v (v.id)}
							<article class="group flex w-full items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-muted/50">
								<div class="min-w-0 flex-1">
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<span class="text-sm font-medium">v{v.id}</span>
										<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{v.label}</span>
									</div>
									<p class="mt-1 truncate text-xs text-muted-foreground">{v.title} · {v.time}</p>
								</div>
								{#if v.wordDiff}
									<span class="shrink-0 text-xs tabular-nums text-muted-foreground">{v.wordDiff}</span>
								{/if}
								<Button variant="outline" size="icon" class="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-label="恢复版本 {v.id}">
									<IconRestore data-icon="inline-start" />
								</Button>
							</article>
						{/each}
					</div>
				</aside>

				<!-- 内容预览 / 差异对比区 -->
				<div class="flex min-h-0 flex-col bg-muted/30">
					<div class="flex h-10 shrink-0 items-center justify-between border-b px-4 text-xs text-muted-foreground">
						<span>v{sd.version - 1 > 0 ? sd.version - 1 : 1} → v{sd.version} 当前</span>
					</div>
					<div class="min-h-0 flex-1 overflow-auto p-4">
						<div class="flex items-center justify-between gap-3">
							<h3 class="text-sm font-medium">草稿内容预览</h3>
							<span class="text-xs tabular-nums text-muted-foreground">v{sd.version}</span>
						</div>
						<div class="mt-4 rounded-lg border bg-background p-8 text-center">
							<p class="text-sm text-muted-foreground">
								选择上方版本列表中的版本进行对比，<br />或点击「编辑」进入完整编辑器。
							</p>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<!-- 未选择草稿时的占位 -->
			<div class="flex flex-1 items-center justify-center p-8">
				<div class="flex flex-col items-center gap-2 text-center">
					<IconArticle class="size-10 text-muted-foreground/40" />
					<h3 class="text-lg font-semibold tracking-tight">选择一篇草稿</h3>
					<p class="text-sm text-muted-foreground">从左侧列表中选择草稿以查看详情</p>
				</div>
			</div>
		{/if}
	</MasterDetail.Pane>
</MasterDetail.Root>

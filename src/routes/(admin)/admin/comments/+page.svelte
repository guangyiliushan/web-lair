<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconFilter from '@tabler/icons-svelte-runes/icons/filter';
	import IconInbox from '@tabler/icons-svelte-runes/icons/inbox';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconArrowBackUp from '@tabler/icons-svelte-runes/icons/arrow-back-up';
	import IconChevronLeft from '@tabler/icons-svelte-runes/icons/chevron-left';
	import IconGlobe from '@tabler/icons-svelte-runes/icons/globe';
	import IconClock from '@tabler/icons-svelte-runes/icons/clock';

	let { data }: PageProps = $props();

	interface CommentItem {
		id: string;
		author: string;
		avatar: string;
		content: string;
		targetTitle: string;
		targetUrl: string;
		ip: string;
		status: 'unread' | 'read' | 'awaiting' | 'whisper' | 'junk';
		createdAt: string;
	}

	type TabId = 'all' | 'unread' | 'awaiting' | 'whisper' | 'read' | 'junk';

	let activeTab = $state<TabId>('unread');
	let selectedComment = $state<CommentItem | null>(null);

	const filteredComments = $derived(
		activeTab === 'all' ? data.comments : data.comments.filter((c) => c.status === activeTab)
	);

	function selectComment(c: CommentItem) {
		selectedComment = c;
	}

	function avatarText(name: string): string {
		return name.slice(0, 1).toUpperCase();
	}

	function statusBadge(status: string) {
		const map: Record<string, { label: string; class: string }> = {
			unread: { label: '未读', class: 'bg-accent/15 text-accent' },
			read: { label: '已读', class: 'bg-muted text-muted-foreground' },
			awaiting: {
				label: '待回复',
				class: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
			},
			whisper: {
				label: '悄悄话',
				class: 'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300'
			},
			junk: { label: '垃圾', class: 'bg-destructive/10 text-destructive' }
		};
		return map[status] ?? { label: status, class: 'bg-muted text-muted-foreground' };
	}
</script>

<svelte:head>
	<title>评论管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0">
	<!-- Left Panel: Comment List (40%) -->
	<div class="flex h-full min-h-0 flex-1 flex-col bg-background" style="flex: 40 1 0px">
		<!-- Tab Bar -->
		<div class="bg-surface-card shrink-0 border-b">
			<div class="flex h-12 shrink-0 items-stretch gap-2 px-3">
				<!-- Tabs -->
				<div class="flex min-w-0 flex-1 items-stretch">
					<div
						class="relative flex h-full min-w-0 flex-1 scrollbar-none items-stretch overflow-x-auto"
						role="tablist"
						aria-label="评论状态"
					>
						{#each data.tabs as tab (tab.id)}
							{@const isActive = activeTab === tab.id}
							<button
								class="relative inline-flex h-full shrink-0 items-center gap-1.5 px-3 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15 focus-visible:outline-hidden"
								class:text-foreground={isActive}
								class:text-muted-foreground={!isActive}
								class:hover:text-foreground={!isActive}
								role="tab"
								type="button"
								aria-selected={isActive}
								onclick={() => {
									activeTab = tab.id;
									selectedComment = null;
								}}
							>
								{#if isActive}
									<span
										aria-hidden="true"
										class="bg-surface-inset absolute inset-x-0 inset-y-2 rounded-sm"
									></span>
								{/if}
								<span class="relative z-10">{tab.label}</span>
								{#if data.counts[tab.id] > 0}
									<span class="relative z-10 ml-0.5 text-xs opacity-60">{data.counts[tab.id]}</span>
								{/if}
							</button>
						{/each}
					</div>
				</div>
				<!-- Actions -->
				<div class="flex shrink-0 items-center gap-1">
					<button
						type="button"
						aria-label="刷新"
						title="刷新"
						class="hover:bg-surface-inset inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						<IconRefresh class="size-4" />
					</button>
					<button
						type="button"
						aria-label="评论状态"
						class="hover:bg-surface-inset inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						<IconFilter class="size-4" />
					</button>
				</div>
				<!-- Search -->
				<div class="relative flex h-full w-8 shrink-0 items-center">
					<button
						type="button"
						aria-label="搜索评论"
						class="hover:bg-surface-inset inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						<IconSearch class="size-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- Comment List or Empty State -->
		{#if filteredComments.length === 0}
			<div class="flex flex-1 items-center justify-center p-6">
				<div
					class="bg-surface-inset flex max-w-sm flex-col items-center justify-center gap-3 rounded-xl p-10 text-center"
				>
					<span
						class="bg-surface-card flex size-11 items-center justify-center rounded-lg shadow-xs"
					>
						<IconInbox class="size-5 text-muted-foreground" />
					</span>
					<div class="space-y-1">
						<div class="text-base font-semibold">全部处理完毕</div>
						<div class="text-sm text-muted-foreground">没有未读评论，干得漂亮。</div>
					</div>
					<Button variant="outline" size="sm" onclick={() => (activeTab = 'all')}>查看全部</Button>
				</div>
			</div>
		{:else}
			<div class="min-h-0 flex-1 overflow-auto">
				{#each filteredComments as comment (comment.id)}
					{@const badge = statusBadge(comment.status)}
					{@const isSelected = selectedComment?.id === comment.id}
					<button
						class="w-full border-b px-4 py-3.5 text-left transition-colors hover:bg-muted/50 {isSelected
							? 'bg-muted/30'
							: ''}"
						type="button"
						onclick={() => selectComment(comment)}
					>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span
										class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
									>
										{avatarText(comment.author)}
									</span>
									<span class="truncate text-sm font-medium">{comment.author}</span>
									<span class="shrink-0 rounded px-1.5 py-0.5 text-xs {badge.class}"
										>{badge.label}</span
									>
								</div>
								<p class="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{comment.content}</p>
								<div class="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground/70">
									<span class="inline-flex items-center gap-1">
										<IconExternalLink class="size-3" />
										<span class="truncate">{comment.targetTitle}</span>
									</span>
									<span class="inline-flex items-center gap-1">
										<IconClock class="size-3" />
										{comment.createdAt}
									</span>
								</div>
							</div>
						</div>
					</button>
				{/each}
				<div class="flex items-center justify-center px-4 py-6 text-sm text-muted-foreground">
					<span>已全部加载</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- Resizable Handle -->
	<div
		class="relative w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent/50"
		role="separator"
	></div>

	<!-- Right Panel: Comment Detail (60%) -->
	<div class="bg-surface-card flex h-full min-h-0 flex-col" style="flex: 60 1 0px">
		{#if selectedComment}
			{@const badge = statusBadge(selectedComment.status)}
			<!-- Detail Header -->
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-5">
				<div class="flex min-w-0 items-center gap-2">
					<button
						type="button"
						aria-label="返回列表"
						class="hover:bg-surface-inset inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
						onclick={() => (selectedComment = null)}
					>
						<IconChevronLeft class="size-4" />
					</button>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span class="truncate text-sm font-medium">{selectedComment.author} 的评论</span>
							<span class="shrink-0 rounded px-1.5 py-0.5 text-xs {badge.class}">{badge.label}</span
							>
						</div>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<Button variant="outline" size="sm" class="h-8 gap-1 px-2 text-xs">
						<IconCheck class="size-3.5" /> 通过
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
					>
						<IconTrash class="size-3.5" /> 垃圾
					</Button>
				</div>
			</div>

			<!-- Detail Content -->
			<div class="min-h-0 flex-1 overflow-auto">
				<div class="p-5">
					<!-- Author info -->
					<div class="mb-5 flex items-center gap-3">
						<span
							class="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-medium"
						>
							{avatarText(selectedComment.author)}
						</span>
						<div class="min-w-0">
							<div class="font-medium">{selectedComment.author}</div>
							<div class="flex items-center gap-3 text-xs text-muted-foreground">
								<span class="inline-flex items-center gap-1">
									<IconGlobe class="size-3" />
									{selectedComment.ip}
								</span>
								<span class="inline-flex items-center gap-1">
									<IconClock class="size-3" />
									{selectedComment.createdAt}
								</span>
							</div>
						</div>
					</div>

					<!-- Comment Content -->
					<div class="bg-surface-inset rounded-lg p-4">
						<p class="text-sm leading-6 wrap-break-word whitespace-pre-wrap">
							{selectedComment.content}
						</p>
					</div>

					<!-- Target Article -->
					<div class="mt-4 rounded-lg border p-4">
						<div class="flex items-center justify-between gap-2">
							<div class="min-w-0">
								<div class="text-xs text-muted-foreground">评论于</div>
								<a
									href={selectedComment.targetUrl}
									class="mt-0.5 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
								>
									{selectedComment.targetTitle}
									<IconExternalLink class="size-3.5" />
								</a>
							</div>
						</div>
					</div>

					<!-- Reply Area -->
					<div class="mt-6 space-y-3">
						<div class="flex items-center justify-between">
							<h3 class="text-sm font-medium">回复</h3>
						</div>
						<textarea
							class="bg-surface-card min-h-24 w-full resize-y rounded-sm border px-3 py-2 text-sm leading-6 outline-hidden transition-colors placeholder:text-muted-foreground/60 focus:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/15"
							placeholder="输入回复内容..."></textarea>
						<div class="flex justify-end gap-2">
							<Button variant="outline" size="sm">保存草稿</Button>
							<Button size="sm">
								<IconArrowBackUp class="size-4" />
								回复
							</Button>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<!-- Empty Detail State -->
			<div class="flex h-full min-h-72 items-center justify-center px-4">
				<div
					class="bg-surface-inset flex flex-col items-center justify-center gap-3 rounded-xl p-10 text-center"
				>
					<span
						class="bg-surface-card flex size-11 items-center justify-center rounded-lg shadow-xs"
					>
						<IconMessage class="size-5 text-muted-foreground" />
					</span>
					<div class="space-y-1">
						<div class="text-base font-semibold">选择一条评论</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

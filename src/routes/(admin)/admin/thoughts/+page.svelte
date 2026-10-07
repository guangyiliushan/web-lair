<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import IconNote from '@tabler/icons-svelte-runes/icons/note';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconThumbDown from '@tabler/icons-svelte-runes/icons/thumb-down';

	interface Memo {
		id: string;
		content: string;
		upVotes: number;
		downVotes: number;
		createdAt: string;
	}

	const items: Memo[] = [
		{ id: '1', content: 'adsa', upVotes: 0, downVotes: 0, createdAt: '2026/07/17 17:07' }
	];

	let addDialogOpen = $state(false);
	let formContent = $state('');

	function openAddDialog() {
		formContent = '';
		addDialogOpen = true;
	}

	function handleSave() {
		if (!formContent.trim()) return;
		// TODO: save via API
		addDialogOpen = false;
	}
</script>

<svelte:head>
	<title>速记管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<!-- 页面头部 -->
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<h2 class="inline-flex items-center gap-2 text-lg font-semibold">
				<IconNote class="size-4" />
				速记
			</h2>
		</div>
		<div class="flex shrink-0 items-center gap-3">
			<span class="text-xs text-muted-foreground">{items.length} 条</span>
			<Button size="sm" variant="outline" onclick={openAddDialog}>
				<IconPlus class="size-4" />
				写一条速记
			</Button>
		</div>
	</header>

	<!-- 速记列表 -->
	<div class="min-h-0 flex-1 overflow-auto">
		<div class="mx-auto max-w-4xl divide-y" role="feed" aria-label="速记列表">
			{#if items.length === 0}
				<div class="flex flex-col items-center gap-1 py-12">
					<p class="text-sm text-muted-foreground">暂无速记</p>
				</div>
			{:else}
				{#each items as item (item.id)}
					<article class="group px-4 py-5 transition-colors hover:bg-muted/50">
						<p class="text-base leading-7 wrap-break-word whitespace-pre-wrap">{item.content}</p>
						<footer class="mt-4 flex flex-wrap items-center justify-between gap-3">
							<div
								class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
							>
								<time>{item.createdAt}</time>
								<span class="inline-flex items-center gap-2">
									<span class="inline-flex items-center gap-1">
										<IconThumbUp class="size-3.5" />
										{item.upVotes}
									</span>
									<span class="h-3 w-px bg-border"></span>
									<span class="inline-flex items-center gap-1">
										<IconThumbDown class="size-3.5" />
										{item.downVotes}
									</span>
								</span>
							</div>
							<div
								class="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
							>
								<Button
									variant="outline"
									size="sm"
									class="h-8 gap-1 px-2 text-xs"
									aria-label="编辑速记"
								>
									<IconPencil class="size-3.5" />
									<span class="hidden sm:inline">编辑</span>
								</Button>
								<Button
									variant="outline"
									size="sm"
									class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
									aria-label="删除速记"
								>
									<IconTrash class="size-3.5" />
									<span class="hidden sm:inline">删除</span>
								</Button>
							</div>
						</footer>
					</article>
				{/each}
			{/if}
			{#if items.length > 0}
				<div class="flex items-center justify-center px-4 py-6 text-sm text-muted-foreground">
					<span>已全部加载</span>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- 写一条速记对话框 -->
<Dialog.Root bind:open={addDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<form
			class="flex flex-col"
			onsubmit={(e) => {
				e.preventDefault();
				handleSave();
			}}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>写一条速记</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-5 py-4">
				<label class="grid gap-1.5">
					<span class="text-sm font-medium">
						内容 <span class="text-destructive">*</span>
					</span>
					<Textarea
						class="min-h-36"
						placeholder="写点什么，或粘贴一个链接..."
						required
						bind:value={formContent}
					/>
				</label>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<span class="mr-auto text-xs text-muted-foreground">Cmd/Ctrl + Enter 快速保存</span>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" size="sm" disabled={!formContent.trim()}>保存</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Empty } from '$lib/components/ui/empty';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	interface Say {
		id: string;
		content: string;
		author: string;
		source: string;
		createdAt: string;
	}

	const says: Say[] = [
		{
			id: '1',
			content: '胆小鬼连幸福都害怕，碰到棉花也会受伤，有时还被幸福所伤。',
			author: '太宰治',
			source: '人间失格',
			createdAt: '2年前'
		},
		{
			id: '2',
			content:
				'以前啊，我们都向往着，可以拥有更好的未来；现在啊，我们回头看，曾经的岁月竟然就是我们的巅峰了。',
			author: '',
			source: '你也走了很远的路吧',
			createdAt: '3年前'
		},
		{
			id: '3',
			content:
				'我们今天生活的时代是一个慕强的时代，作为弱者是很痛苦的，因为周边的人都比你强。狮子和兔子，兔子想说话，狮子说，你的牙齿呢，你闭嘴。可是狮子在大象面前，狮子又变成了那个弱者。一个慕强的人，生活在恐惧之中，因为他生怕自己不够强。接受有限性，才能过得充足，才能原谅别人的不足。人最大的功课就是和解，跟他人和解，跟自己和解，跟命运和解。',
			author: '罗翔',
			source: '如何在阅读中超越有限的今生',
			createdAt: '3年前'
		},
		{
			id: '4',
			content:
				'世事无常，生命是短暂的，我们都活在生死边缘，哪怕只有一天，一刹那，我们都想要活下去。',
			author: '铃芽户缔',
			source: '',
			createdAt: '3年前'
		},
		{
			id: '5',
			content:
				'每逢你想要批评任何人的时候，你就记住，这个世界上所有的人，并不是个个都有过你拥有的那些优越条件。',
			author: '弗朗西斯·斯科特·菲茨杰拉德',
			source: '了不起的盖茨比',
			createdAt: '4年前'
		},
		{
			id: '6',
			content:
				'生活不可能像你想象得那么好，但也不会像你想象得那么糟。我觉得人的脆弱和坚强都超乎自己的想象。有时，我可能脆弱得一句话就泪流满面；有时，也发现自己咬着牙走了很长的路。',
			author: '莫泊桑',
			source: '一生',
			createdAt: '4年前'
		}
	];

	let addDialogOpen = $state(false);

	let formContent = $state('');
	let formAuthor = $state('');
	let formSource = $state('');

	function resetForm() {
		formContent = '';
		formAuthor = '';
		formSource = '';
	}

	function handleAdd() {
		if (!formContent.trim()) return;
		// TODO: add say via API
		resetForm();
		addDialogOpen = false;
	}
</script>

<svelte:head>
	<title>一言管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<!-- 页面头部 -->
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center border bg-muted text-muted-foreground"
			>
				<IconQuote class="size-4" />
			</span>
			<div class="flex min-w-0 items-baseline gap-2">
				<h1 class="truncate text-base font-semibold">一言</h1>
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{says.length} 条</span>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline" onclick={() => (addDialogOpen = true)}>
				<IconPlus class="size-3.5" />
				添加一言
			</Button>
		</div>
	</header>

	<!-- 添加一言对话框 -->
	<Dialog.Root bind:open={addDialogOpen}>
		<Dialog.Content class="sm:max-w-lg">
			<form
				class="flex flex-col"
				onsubmit={(e) => {
					e.preventDefault();
					handleAdd();
				}}
			>
				<Dialog.Header>
					<div class="flex items-center justify-between gap-3">
						<Dialog.Title>添加一言</Dialog.Title>
						<Dialog.Close>
							{#snippet child({ props })}
								<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
									<IconX class="size-4" />
								</Button>
							{/snippet}
						</Dialog.Close>
					</div>
				</Dialog.Header>
				<div class="grid gap-4 px-5 py-4">
					<div class="grid gap-1.5">
						<label for="say-content" class="text-sm font-medium">
							内容<span class="text-destructive"> *</span>
						</label>
						<Textarea
							id="say-content"
							class="min-h-28"
							placeholder="记录一句有意思的话..."
							bind:value={formContent}
							required
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="say-author" class="text-sm font-medium">作者</label>
						<Input id="say-author" placeholder="谁说的？" bind:value={formAuthor} />
					</div>
					<div class="grid gap-1.5">
						<label for="say-source" class="text-sm font-medium">来源</label>
						<Input id="say-source" placeholder="出自哪里？" bind:value={formSource} />
					</div>
				</div>
				<Dialog.Footer class="border-t px-4 py-2">
					<span class="mr-auto text-xs text-muted-foreground">Cmd/Ctrl + Enter 快速保存</span>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" size="sm" {...props}>取消</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" size="sm" disabled={!formContent.trim()}>发布</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>

	<!-- 说说列表 -->
	<div class="min-h-0 flex-1 overflow-auto">
		{#if says.length === 0}
			<Empty class="py-12">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">暂无说说</h3>
					<p class="text-sm text-muted-foreground">点击上方按钮添加第一条一言</p>
				</div>
			</Empty>
		{:else}
			<div class="mx-auto max-w-5xl">
				{#each says as say (say.id)}
					<article
						class="group border-b px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/50"
					>
						<div class="flex gap-3">
							<IconQuote class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<p class="text-base leading-relaxed">{say.content}</p>
								<div
									class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
								>
									{#if say.author}
										<span>{say.author}</span>
									{/if}
									{#if say.source}
										<span class="italic">《{say.source}》</span>
									{/if}
									<time class="text-muted-foreground/70">{say.createdAt}</time>
								</div>
							</div>
							<div
								class="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100"
							>
								<Button
									variant="outline"
									size="sm"
									class="h-8 gap-1 px-2 text-xs"
									href="/admin/says/{say.id}/edit"
								>
									<IconPencil class="size-3.5" />
									<span class="hidden sm:inline">编辑</span>
								</Button>
								<Button
									variant="outline"
									size="sm"
									class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
								>
									<IconTrash class="size-3.5" />
									<span class="hidden sm:inline">删除</span>
								</Button>
							</div>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</div>
</div>

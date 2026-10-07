<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Empty } from '$lib/components/ui/empty';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { DeleteConfirm } from '$lib/components/admin';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type QuoteRow = Awaited<PageProps['data']['rows']>[number];

	// ── Add / edit dialog ──
	let dialogOpen = $state(false);
	let editing = $state<QuoteRow | null>(null);
	let fieldContent = $state('');
	let fieldAuthor = $state('');
	let fieldSource = $state('');
	// Double-submit guard (C3 review): kit does not merge submissions.
	let submitting = $state(false);

	// Dashboard 撰写 deep link: /admin/quotes?add=1 opens the dialog once.
	let addConsumed = false;
	$effect(() => {
		if (!addConsumed && page.url.searchParams.get('add') === '1') {
			addConsumed = true;
			openCreate();
		}
	});

	function openCreate() {
		editing = null;
		fieldContent = '';
		fieldAuthor = '';
		fieldSource = '';
		dialogOpen = true;
	}

	function openEdit(row: QuoteRow) {
		editing = row;
		fieldContent = row.content;
		fieldAuthor = row.author ?? '';
		fieldSource = row.source ?? '';
		dialogOpen = true;
	}

	/** Close the dialog once an action succeeds; failures keep it open with the error shown. */
	function closeOnSuccess() {
		return async ({
			result,
			update
		}: {
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
		}) => {
			submitting = false;
			if (result.type !== 'failure') dialogOpen = false;
			await update();
		};
	}

	// ── Delete confirm ──
	let deleteTarget = $state<QuoteRow | null>(null);

	const errorMessage = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);
</script>

<svelte:head>
	<title>摘录管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center border bg-muted text-muted-foreground"
			>
				<IconQuote class="size-4" />
			</span>
			<div class="flex min-w-0 items-baseline gap-2">
				<h1 class="truncate text-base font-semibold">摘录</h1>
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{data.total} 条</span>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline" onclick={openCreate}>
				<IconPlus class="size-3.5" />
				添加摘录
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<div
			role="alert"
			class="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
		>
			{errorMessage}
		</div>
	{/if}

	<!-- 添加 / 编辑摘录对话框 -->
	<Dialog.Root bind:open={dialogOpen}>
		<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
			<form
				method="post"
				action={editing ? '?/update' : '?/create'}
				class="flex flex-col"
				use:enhance={() => {
					submitting = true;
					return closeOnSuccess();
				}}
			>
				{#if editing}
					<input type="hidden" name="id" value={editing.id} />
				{/if}
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<Dialog.Title>{editing ? '编辑摘录' : '添加摘录'}</Dialog.Title>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
								<IconX class="size-4" />
							</Button>
						{/snippet}
					</Dialog.Close>
				</div>
				{#if errorMessage}
					<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
				{/if}
				<div class="grid gap-4 px-5 py-4">
					<div class="grid gap-1.5">
						<label for="quote-content" class="text-sm font-medium">
							内容<span class="text-destructive"> *</span>
						</label>
						<Textarea
							id="quote-content"
							name="content"
							class="min-h-28"
							placeholder="记录一句有意思的话..."
							bind:value={fieldContent}
							required
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="quote-author" class="text-sm font-medium">作者</label>
						<Input
							id="quote-author"
							name="author"
							placeholder="谁说的？"
							bind:value={fieldAuthor}
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="quote-source" class="text-sm font-medium">来源</label>
						<Input
							id="quote-source"
							name="source"
							placeholder="出自哪里？"
							bind:value={fieldSource}
						/>
					</div>
				</div>
				<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" size="sm" {...props}>取消</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" size="sm" disabled={submitting || !fieldContent.trim()}>
						{editing ? '保存' : '添加'}
					</Button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Root>

	<DeleteConfirm
		open={deleteTarget !== null}
		title="删除摘录"
		description="将删除这条摘录，此操作不可撤销。"
		id={deleteTarget?.id ?? ''}
		error={deleteTarget ? errorMessage : null}
		onclose={() => (deleteTarget = null)}
	/>

	<!-- 摘录列表（流式加载：先骨架后内容，ui-ux C1） -->
	<div class="min-h-0 flex-1 overflow-auto">
		{#await data.rows}
			<div class="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6" aria-hidden="true">
				{#each [0, 1, 2, 3, 4] as i (i)}
					<Skeleton class="h-20 w-full" />
				{/each}
			</div>
		{:then rows}
			{#if rows.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">暂无摘录</h3>
						<p class="text-sm text-muted-foreground">点击上方按钮添加第一条摘录</p>
					</div>
				</Empty>
			{:else}
				<div class="mx-auto max-w-5xl" role="list" aria-label="摘录列表">
					{#each rows as row (row.id)}
						<article
							role="listitem"
							class="group border-b px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/50"
						>
							<div class="flex gap-3">
								<IconQuote class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
								<div class="min-w-0 flex-1">
									<p class="text-base leading-relaxed">{row.content}</p>
									<div
										class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
									>
										{#if row.author}
											<span>{row.author}</span>
										{/if}
										{#if row.source}
											<span class="italic">《{row.source}》</span>
										{/if}
										<span class="text-muted-foreground/70">{row.dateLabel}</span>
									</div>
								</div>
								<div
									class="flex shrink-0 items-start gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
								>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 px-2 text-xs"
										aria-label="编辑摘录"
										onclick={() => openEdit(row)}
									>
										<IconPencil class="size-3.5" />
										<span class="hidden sm:inline">编辑</span>
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
										aria-label="删除摘录"
										onclick={() => (deleteTarget = row)}
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
		{/await}
	</div>
</div>

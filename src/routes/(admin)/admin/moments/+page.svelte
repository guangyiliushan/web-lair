<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Empty } from '$lib/components/ui/empty';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconThumbDown from '@tabler/icons-svelte-runes/icons/thumb-down';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type MomentRow = Awaited<PageProps['data']['rows']>[number];
	type MomentKind = 'life' | 'tech' | 'media' | 'other';

	const KIND_LABELS: Record<MomentKind, string> = {
		life: '生活',
		tech: '技术',
		media: '书影',
		other: '其他'
	};
	const KINDS = Object.keys(KIND_LABELS) as MomentKind[];

	// ── Add / edit dialog ──
	let dialogOpen = $state(false);
	let editing = $state<MomentRow | null>(null);
	let fieldContent = $state('');
	let fieldType = $state<MomentKind>('life');

	// Dashboard 撰写 deep link: /admin/moments?add=1 opens the dialog once.
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
		fieldType = 'life';
		dialogOpen = true;
	}

	function openEdit(row: MomentRow) {
		editing = row;
		fieldContent = row.content;
		fieldType = (row.type as MomentKind) ?? 'life';
		dialogOpen = true;
	}

	// ── Delete confirm ──
	let deleteTarget = $state<MomentRow | null>(null);

	const errorMessage = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);
</script>

<svelte:head>
	<title>微记管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center border bg-muted text-muted-foreground"
			>
				<IconWriting class="size-4" />
			</span>
			<div class="flex min-w-0 items-baseline gap-2">
				<h1 class="truncate text-base font-semibold">微记</h1>
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{data.total} 条</span>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline" onclick={openCreate}>
				<IconPlus class="size-3.5" />
				写一条微记
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

	<!-- 写一条 / 编辑微记对话框 -->
	<Dialog.Root bind:open={dialogOpen}>
		<Dialog.Content class="sm:max-w-lg">
			<form
				method="post"
				action={editing ? '?/update' : '?/create'}
				class="flex flex-col"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') dialogOpen = false;
						await update();
					}}
			>
				{#if editing}
					<input type="hidden" name="id" value={editing.id} />
				{/if}
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<Dialog.Title>{editing ? '编辑微记' : '写一条微记'}</Dialog.Title>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
								<IconX class="size-4" />
							</Button>
						{/snippet}
					</Dialog.Close>
				</div>
				<div class="grid gap-4 px-5 py-4">
					<label class="grid gap-1.5">
						<span class="text-sm font-medium">
							内容 <span class="text-destructive">*</span>
						</span>
						<Textarea
							name="content"
							class="min-h-28"
							placeholder="此刻的碎片..."
							required
							bind:value={fieldContent}
						/>
					</label>
					<div class="grid gap-1.5">
						<span class="text-sm font-medium">类型</span>
						<div class="flex flex-wrap gap-2" role="radiogroup" aria-label="微记类型">
							{#each KINDS as kind (kind)}
								<label
									class="rounded-full border px-3 py-1 text-xs transition-colors focus-within:ring-2 focus-within:ring-ring/50 {fieldType ===
									kind
										? 'border-primary/40 bg-primary/10 text-primary'
										: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
								>
									<input
										type="radio"
										name="type"
										value={kind}
										bind:group={fieldType}
										class="sr-only"
									/>
									{KIND_LABELS[kind]}
								</label>
							{/each}
						</div>
					</div>
				</div>
				<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" size="sm" {...props}>取消</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" size="sm" disabled={!fieldContent.trim()}>
						{editing ? '保存' : '发布'}
					</Button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Root>

	<!-- 删除确认 -->
	<AlertDialog.Root
		open={deleteTarget !== null}
		onOpenChange={(open) => {
			if (!open) deleteTarget = null;
		}}
	>
		<AlertDialog.Content>
			<AlertDialog.Header>
				<AlertDialog.Title>删除微记</AlertDialog.Title>
				<AlertDialog.Description>将删除这条微记，此操作不可撤销。</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>取消</AlertDialog.Cancel>
				<form
					method="post"
					action="?/delete"
					use:enhance={() =>
						async ({ result, update }) => {
							if (result.type === 'success') deleteTarget = null;
							await update();
						}}
				>
					<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
					<Button type="submit" variant="destructive">删除</Button>
				</form>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>

	<!-- 微记列表（流式加载：先骨架后内容，ui-ux C1） -->
	<div class="min-h-0 flex-1 overflow-auto">
		{#await data.rows}
			<div class="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-6" aria-hidden="true">
				{#each [0, 1, 2, 3, 4] as i (i)}
					<Skeleton class="h-16 w-full" />
				{/each}
			</div>
		{:then rows}
			{#if rows.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">暂无微记</h3>
						<p class="text-sm text-muted-foreground">点击上方按钮写下第一条微记</p>
					</div>
				</Empty>
			{:else}
				<div class="mx-auto max-w-4xl divide-y" role="feed" aria-label="微记列表">
					{#each rows as row (row.id)}
						<article class="group px-4 py-5 transition-colors hover:bg-muted/50">
							<p class="text-base leading-7 wrap-break-word whitespace-pre-wrap">{row.content}</p>
							<footer class="mt-4 flex flex-wrap items-center justify-between gap-3">
								<div
									class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
								>
									<span class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
										{KIND_LABELS[row.type as MomentKind] ?? row.type}
									</span>
									<time>{row.dateLabel}</time>
									<span class="inline-flex items-center gap-2">
										<span class="inline-flex items-center gap-1">
											<IconThumbUp class="size-3.5" />
											{row.up}
										</span>
										<span class="h-3 w-px bg-border"></span>
										<span class="inline-flex items-center gap-1">
											<IconThumbDown class="size-3.5" />
											{row.down}
										</span>
									</span>
								</div>
								<div
									class="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
								>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 px-2 text-xs"
										aria-label="编辑微记"
										onclick={() => openEdit(row)}
									>
										<IconPencil class="size-3.5" />
										<span class="hidden sm:inline">编辑</span>
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
										aria-label="删除微记"
										onclick={() => (deleteTarget = row)}
									>
										<IconTrash class="size-3.5" />
										<span class="hidden sm:inline">删除</span>
									</Button>
								</div>
							</footer>
						</article>
					{/each}
				</div>
			{/if}
		{/await}
	</div>
</div>

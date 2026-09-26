<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageProps } from './$types';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';

	let { data }: PageProps = $props();

	let discardTarget = $state<{ draftId: string; title: string } | null>(null);
	let discarding = $state(false);

	const KIND_LABELS: Record<string, string> = {
		new: '新文',
		translation: '译文',
		edit: '改动'
	};
	const KIND_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
		new: 'secondary',
		translation: 'outline',
		edit: 'default'
	};

	const discardedFlash = $derived(page.url.searchParams.get('discarded') === '1');

	const discardHandler =
		() =>
		async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
			discarding = false;
			if (result.type === 'failure') {
				discardTarget = null;
				return;
			}
			await update();
		};
</script>

<svelte:head>
	<title>草稿箱 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if discardedFlash}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			草稿已丢弃。
		</div>
	{/if}

	{#if data.drafts.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无草稿</h3>
				<p class="text-sm text-muted-foreground">
					编辑文章时的未发布改动会出现在这里；草稿不自动清理，直到发布或显式丢弃。
				</p>
			</div>
			<div class="mt-4">
				<Button href="/admin/posts">
					<IconArticle data-icon="inline-start" />
					去看文章列表
				</Button>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>标题</Table.Head>
						<Table.Head class="w-20">类型</Table.Head>
						<Table.Head class="w-16">语言</Table.Head>
						<Table.Head class="w-24">文章状态</Table.Head>
						<Table.Head class="hidden w-40 sm:table-cell">最近修改</Table.Head>
						<Table.Head class="w-24 text-right">操作</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.drafts as draft (draft.draftId)}
						<Table.Row>
							<Table.Cell class="max-w-0 truncate font-medium">
								{#if draft.postId}
									<a href="/admin/posts/edit?id={draft.postId}" class="hover:text-primary">
										{draft.title}
									</a>
								{:else}
									{draft.title}
								{/if}
							</Table.Cell>
							<Table.Cell>
								<Badge variant={KIND_VARIANTS[draft.kind]} class="text-xs">
									{KIND_LABELS[draft.kind]}
								</Badge>
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">{draft.lang}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground"
								>{draft.postStatus ?? '—'}</Table.Cell
							>
							<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
								{draft.updatedAt
									? formatDateTime(new Date(draft.updatedAt), {
											dateStyle: 'short',
											timeStyle: 'short'
										})
									: '—'}
							</Table.Cell>
							<Table.Cell class="text-right">
								<div class="flex items-center justify-end gap-1">
									{#if draft.postId}
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											href="/admin/posts/edit?id={draft.postId}"
										>
											<IconPencil class="size-4" />
										</Button>
									{/if}
									<Button
										variant="ghost"
										size="icon"
										class="size-8 text-destructive"
										onclick={() => (discardTarget = { draftId: draft.draftId, title: draft.title })}
										aria-label="丢弃草稿"
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

<!-- 丢弃确认（共享一个对话框；表单的 draftId 跟随目标更新） -->
<AlertDialog.Root
	open={discardTarget !== null}
	onOpenChange={(open) => {
		if (!open) discardTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>丢弃草稿？</AlertDialog.Title>
			<AlertDialog.Description>
				将删除「{discardTarget?.title ??
					''}」的未发布改动。若是从未发布过的新文章，连占位记录一并删除。此操作不可撤销。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form method="POST" action="?/discard" use:enhance={discardHandler}>
				<input type="hidden" name="draftId" value={discardTarget?.draftId ?? ''} />
				<Button type="submit" variant="destructive" disabled={discarding}>
					{discarding ? '丢弃中…' : '丢弃'}
				</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

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
	import { m } from '$lib/paraglide/messages';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';

	let { data }: PageProps = $props();

	let discardTarget = $state<{ draftId: string; title: string } | null>(null);
	let discarding = $state(false);

	const KIND_LABELS: Record<string, string> = {
		new: m.admin_drafts_kind_new(),
		translation: m.admin_drafts_kind_translation(),
		edit: m.admin_drafts_kind_edit()
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
	<title>{m.admin_nav_drafts()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if discardedFlash}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			{m.admin_drafts_discarded_flash()}
		</div>
	{/if}

	{#if data.drafts.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">{m.admin_drafts_empty()}</h3>
				<p class="text-sm text-muted-foreground">
					{m.admin_drafts_empty_desc()}
				</p>
			</div>
			<div class="mt-4">
				<Button href="/admin/posts">
					<IconArticle data-icon="inline-start" />
					{m.admin_drafts_go_posts()}
				</Button>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>{m.admin_drafts_col_title()}</Table.Head>
						<Table.Head class="w-20">{m.admin_common_type()}</Table.Head>
						<Table.Head class="w-16">{m.admin_posts_edit_lang_label()}</Table.Head>
						<Table.Head class="w-24">{m.admin_drafts_col_post_status()}</Table.Head>
						<Table.Head class="hidden w-40 sm:table-cell">{m.admin_drafts_col_updated()}</Table.Head
						>
						<Table.Head class="w-24 text-right">{m.admin_common_actions()}</Table.Head>
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
										aria-label={m.admin_posts_edit_discard_draft()}
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
			<AlertDialog.Title>{m.admin_drafts_discard_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_drafts_discard_desc({ title: discardTarget?.title ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form method="POST" action="?/discard" use:enhance={discardHandler}>
				<input type="hidden" name="draftId" value={discardTarget?.draftId ?? ''} />
				<Button type="submit" variant="destructive" disabled={discarding}>
					{discarding ? m.admin_drafts_discarding() : m.admin_posts_edit_discard_confirm()}
				</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

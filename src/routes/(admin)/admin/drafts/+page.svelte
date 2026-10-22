<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import { Empty } from '$lib/components/ui/empty';
	import { DeleteConfirm } from '$lib/components/admin';
	import {
		ListRowActions,
		ListTable,
		listColumnClass,
		type ListColumn
	} from '$lib/components/admin/list-table';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';

	let { data, form }: PageProps = $props();

	type DraftRow = (typeof data.drafts)[number];

	/** Failure from `?/discard` - shown inside the confirm dialog. */
	const actionError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);

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

	/** Same column descriptor as every other admin list: head and cells share it. */
	const cols: Record<'title' | 'kind' | 'lang' | 'postStatus' | 'updated' | 'actions', ListColumn> =
		{
			title: { id: 'title', label: m.admin_list_col_title() },
			kind: { id: 'kind', label: m.admin_common_type(), width: 'w-20' },
			lang: { id: 'lang', label: m.admin_posts_edit_lang_label(), width: 'w-16' },
			postStatus: {
				id: 'postStatus',
				label: m.admin_drafts_col_post_status(),
				width: 'w-24',
				hideBelow: 'sm'
			},
			updated: {
				id: 'updated',
				label: m.admin_drafts_col_updated(),
				width: 'w-32',
				hideBelow: 'sm'
			},
			actions: {
				id: 'actions',
				label: m.admin_common_actions(),
				width: 'w-20',
				align: 'right'
			}
		};
	const columns = Object.values(cols);

	const discardedFlash = $derived(page.url.searchParams.get('discarded') === '1');

	// Discarding is irreversible, so it goes through a confirm; there is no
	// milder action to put in the middle slot.
	let discardTarget = $state<DraftRow | null>(null);
</script>

<svelte:head>
	<title>{m.admin_nav_drafts()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-4">
	{#if discardedFlash}
		<div
			role="status"
			class="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
		>
			{m.admin_drafts_discarded_flash()}
		</div>
	{/if}

	<ListTable
		{columns}
		rows={data.drafts}
		rowKey={(draft) => draft.draftId}
		label={m.admin_nav_drafts()}
		class="min-h-96"
	>
		{#snippet row(draft)}
			<Table.Cell class={cn(listColumnClass(cols.title), 'max-w-0 truncate')}>
				{#if draft.postId}
					<a href="/admin/posts/edit?id={draft.postId}" class="hover:text-primary">
						{draft.title}
					</a>
				{:else}
					{draft.title}
				{/if}
			</Table.Cell>
			<Table.Cell class={listColumnClass(cols.kind)}>
				<Badge variant={KIND_VARIANTS[draft.kind]} class="text-xs">
					{KIND_LABELS[draft.kind]}
				</Badge>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.lang), 'text-xs text-muted-foreground')}>
				{draft.lang}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.postStatus), 'text-xs text-muted-foreground')}>
				{draft.postStatus ?? '—'}
			</Table.Cell>
			<Table.Cell
				class={cn(listColumnClass(cols.updated), 'text-xs whitespace-nowrap text-muted-foreground')}
			>
				{draft.updatedAt
					? formatDateTime(new Date(draft.updatedAt), { dateStyle: 'short', timeStyle: 'short' })
					: '—'}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
				<ListRowActions
					editPath={draft.postId ? '/admin/posts/edit' : undefined}
					editId={draft.postId ?? undefined}
					editLabel={m.admin_common_edit()}
					onDelete={() => (discardTarget = draft)}
					deleteLabel={m.admin_posts_edit_discard_draft()}
				/>
			</Table.Cell>
		{/snippet}

		{#snippet empty()}
			<Empty class="mx-auto py-14">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">{m.admin_drafts_empty()}</h3>
					<p class="text-sm text-muted-foreground">{m.admin_drafts_empty_desc()}</p>
				</div>
				<div class="mt-2">
					<Button href="/admin/posts">
						<IconArticle data-icon="inline-start" />
						{m.admin_drafts_go_posts()}
					</Button>
				</div>
			</Empty>
		{/snippet}
	</ListTable>
</div>

<DeleteConfirm
	open={discardTarget !== null}
	title={m.admin_drafts_discard_title()}
	description={m.admin_drafts_discard_desc({ title: discardTarget?.title ?? '' })}
	id={discardTarget?.draftId ?? ''}
	idName="draftId"
	action="?/discard"
	confirmLabel={m.admin_posts_edit_discard_confirm()}
	error={actionError}
	onclose={() => (discardTarget = null)}
/>

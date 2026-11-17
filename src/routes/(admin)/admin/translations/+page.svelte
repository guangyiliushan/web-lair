<script lang="ts">
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as Sheet from '$lib/components/ui/sheet';
	import { DeleteConfirm } from '$lib/components/admin';
	import { Empty } from '$lib/components/ui/empty';
	import {
		ListPagination,
		ListTable,
		listColumnClass,
		type ListColumn
	} from '$lib/components/admin/list-table';
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconTrashX from '@tabler/icons-svelte-runes/icons/trash-x';

	let { data, form }: PageProps = $props();

	/** Bulk-purge confirmation lives beside the sheet/row dialog state. */
	let purgeOpen = $state(false);

	const tabs = [
		{ value: 'draft', label: m.admin_translations_tab_draft() },
		{ value: 'accepted', label: m.admin_translations_tab_accepted() },
		{ value: 'discarded', label: m.admin_translations_tab_discarded() },
		{ value: 'all', label: m.admin_translations_tab_all() }
	] as const;

	/**
	 * Same table the posts list uses: one column array drives head and cells, so
	 * a hidden column can never leave its body cells stranded.
	 */
	const columns: ListColumn[] = [
		{ id: 'candidate', label: m.admin_translations_col_target() },
		{ id: 'source', label: m.admin_translations_col_source(), width: 'w-52', hideBelow: 'lg' },
		{ id: 'lang', label: m.admin_translations_col_lang(), width: 'w-20', hideBelow: 'sm' },
		{ id: 'status', label: m.admin_translations_col_status(), width: 'w-28', hideBelow: 'md' },
		{
			id: 'actions',
			// Icon-only, like the posts list: a labeled row of buttons would eat
			// the title column on narrow screens for no added meaning.
			label: m.admin_translations_col_actions(),
			width: 'w-28',
			align: 'right'
		}
	];
	const cols = Object.fromEntries(columns.map((column) => [column.id, column])) as Record<
		string,
		ListColumn
	>;

	function href(status: string, page = 1): string {
		const parts = [`status=${encodeURIComponent(status)}`];
		if (data.lang) parts.push(`lang=${encodeURIComponent(data.lang)}`);
		if (page > 1) parts.push(`page=${page}`);
		return `?${parts.join('&')}`;
	}

	/** The preview lives in the URL, so it survives a reload and can be linked. */
	function previewHref(id: string): string {
		return `${href(data.status, data.page)}&preview=${encodeURIComponent(id)}`;
	}

	function closePreview(): void {
		void goto(href(data.status, data.page), {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	}

	const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
		draft: 'secondary',
		accepted: 'default',
		discarded: 'outline'
	};

	const preview = $derived(data.preview);
	// A generating row has no `content` yet; its streamed partial is what the
	// proof sheet can show in the meantime.
	const previewCandidate = $derived(preview?.content ?? preview?.partial ?? null);

	/**
	 * Deleting is permanent, so the row button only arms a dialog: the page
	 * owns the target, the shared dialog owns the confirm (and the enhance
	 * that keeps the current status tab in the URL).
	 */
	let deleteTarget = $state<{ id: string; title: string } | null>(null);

	// A failure has to surface inside the dialog (the page banner hides behind
	// the overlay), so it is matched by row id rather than by "some message".
	const deleteFailure = $derived(
		deleteTarget &&
			form &&
			'id' in form &&
			form.id === deleteTarget.id &&
			typeof form.message === 'string'
			? form.message
			: null
	);
</script>

<svelte:head>
	<title>{m.admin_nav_translations()} - Lair Admin</title>
</svelte:head>

<!--
	Full-bleed by design: the page adds no horizontal padding, so the tab row and
	the table sit on the same gutter as their own cells instead of inheriting a
	second inset from the layout.
-->
<div class="flex flex-col gap-3 py-4 lg:py-6">
	<div class="flex flex-wrap items-center gap-1.5 px-2">
		{#each tabs as tab (tab.value)}
			<a
				href={href(tab.value)}
				class="rounded-md border px-2.5 py-1 text-xs {data.status === tab.value
					? 'border-primary bg-primary/10 text-primary-text'
					: 'border-border text-muted-foreground hover:bg-muted'}"
				aria-current={data.status === tab.value ? 'page' : undefined}
			>
				{tab.label}
				{#if data.counts[tab.value] != null}
					<span class="ml-1 opacity-70">{data.counts[tab.value]}</span>
				{/if}
			</a>
		{/each}
		{#if data.canPurge}
			<!-- Housekeeping for the whole table, not for the current filter: the
			     label and the dialog both say "all", so a narrowed tab cannot make
			     it look like a scoped delete. -->
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="ml-auto text-muted-foreground hover:text-destructive"
				onclick={() => (purgeOpen = true)}
			>
				<IconTrashX data-icon="inline-start" />
				{m.admin_translations_purge()}
			</Button>
		{/if}
	</div>

	{#if form?.message}
		<p role="status" class="mx-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
			{form.message}
		</p>
	{/if}

	<ListTable
		{columns}
		rows={data.rows}
		rowKey={(row) => row.id}
		label={m.admin_translations_title()}
	>
		{#snippet row(row)}
			<Table.Cell class={cn(listColumnClass(cols.candidate), 'whitespace-normal')}>
				<div class="flex min-w-0 flex-col gap-1">
					<a href={previewHref(row.id)} class="min-w-0 truncate font-medium hover:text-primary">
						{row.title}
					</a>
					{#if row.error}
						<p class="line-clamp-2 text-xs text-destructive">{row.error}</p>
					{/if}
					<!--
						Whatever the viewport drops from the columns is repeated here, and
						only that: each item hides exactly where its column appears, so no
						width shows the same fact twice or loses it entirely.
					-->
					<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
						<span class="sm:hidden" data-inline="lang">{row.targetLang}</span>
						<span class="md:hidden" data-inline="status">
							<Badge variant={STATUS_VARIANT[row.status] ?? 'outline'} class="text-xs">
								{row.status}
							</Badge>
						</span>
						{#if row.sourceTitle}
							<span class="min-w-0 truncate lg:hidden" data-inline="source">
								{row.sourceType} · {row.sourceTitle}
							</span>
						{/if}
					</div>
				</div>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.source), 'text-xs text-muted-foreground')}>
				<div class="truncate">{row.sourceTitle ?? '—'}</div>
				<div class="mt-0.5 text-[11px] tracking-wide uppercase">{row.sourceType}</div>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.lang), 'text-xs')}>
				{row.targetLang}
			</Table.Cell>
			<Table.Cell class={listColumnClass(cols.status)}>
				<Badge variant={STATUS_VARIANT[row.status] ?? 'outline'} class="text-xs">
					{row.status}
				</Badge>
				{#if row.model}
					<div class="mt-1 max-w-40 truncate text-[11px] text-muted-foreground">
						{row.model}
					</div>
				{/if}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
				<div class="flex flex-wrap items-center justify-end gap-0.5">
					{#if row.contentPreview || row.partial}
						<Button
							href={previewHref(row.id)}
							size="icon-sm"
							variant="ghost"
							title={m.admin_translations_preview()}
							aria-label={`${m.admin_translations_preview()}: ${row.title}`}
						>
							<IconEye />
						</Button>
					{/if}
					{#if row.status === 'draft'}
						{#if row.contentPreview}
							<form method="POST" action="?/accept" use:enhance>
								<input type="hidden" name="id" value={row.id} />
								<Button
									type="submit"
									size="icon-sm"
									title={m.admin_translations_accept()}
									aria-label={`${m.admin_translations_accept()}: ${row.title}`}
								>
									<IconCheck />
								</Button>
							</form>
						{:else}
							<form method="POST" action="?/retry" use:enhance>
								<input type="hidden" name="id" value={row.id} />
								<Button
									type="submit"
									size="icon-sm"
									variant="outline"
									title={m.admin_translations_retry()}
									aria-label={`${m.admin_translations_retry()}: ${row.title}`}
								>
									<IconRefresh />
								</Button>
							</form>
						{/if}
						<form method="POST" action="?/discard" use:enhance>
							<input type="hidden" name="id" value={row.id} />
							<Button
								type="submit"
								size="icon-sm"
								variant="ghost"
								class="text-destructive hover:bg-destructive/10 hover:text-destructive"
								title={m.admin_translations_discard()}
								aria-label={`${m.admin_translations_discard()}: ${row.title}`}
							>
								<IconTrash />
							</Button>
						</form>
					{/if}
					{#if row.status === 'accepted' && (row.targetPostId || row.targetNoteId)}
						<form method="POST" action="?/resync" use:enhance>
							<input type="hidden" name="id" value={row.id} />
							<Button
								type="submit"
								size="icon-sm"
								variant="outline"
								title={m.admin_translations_resync()}
								aria-label={`${m.admin_translations_resync()}: ${row.title}`}
							>
								<IconRefresh />
							</Button>
						</form>
					{/if}
					{#if row.status === 'discarded'}
						<!-- A discarded row has no other action left, so its slot is the
						     permanent delete; `trash-x` keeps it visually distinct from the
						     draft row's "discard", which uses the plain trash icon. -->
						<Button
							variant="ghost"
							size="icon-sm"
							class="text-destructive hover:bg-destructive/10 hover:text-destructive"
							onclick={() => (deleteTarget = { id: row.id, title: row.title })}
							title={m.admin_translations_delete()}
							aria-label={`${m.admin_translations_delete()}: ${row.title}`}
						>
							<IconTrashX />
						</Button>
					{/if}
				</div>
			</Table.Cell>
		{/snippet}

		{#snippet empty()}
			<Empty class="mx-auto py-14">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">
						{m.admin_translations_empty_title()}
					</h3>
					<p class="text-sm text-muted-foreground">{m.admin_translations_empty_desc()}</p>
				</div>
			</Empty>
		{/snippet}

		{#snippet footer()}
			<ListPagination
				total={data.total}
				page={data.page}
				pageSize={20}
				pageHref={(page) => href(data.status, page)}
			/>
		{/snippet}
	</ListTable>
</div>

<!-- Proof sheet: the source and the candidate body side by side. -->
{#if preview}
	<Sheet.Root
		open
		onOpenChange={(open) => {
			if (!open) closePreview();
		}}
	>
		<Sheet.Content
			side="right"
			class="w-full p-0 data-[side=right]:w-full sm:max-w-3xl data-[side=right]:sm:max-w-3xl"
		>
			<div class="flex h-full flex-col">
				<Sheet.Header class="border-b border-border px-6 pt-5 pr-12 pb-4">
					<Sheet.Title class="text-sm font-semibold">{preview.title}</Sheet.Title>
					<Sheet.Description class="text-xs text-muted-foreground">
						{preview.targetLang} · {preview.status}
						{#if preview.sourceTitle}
							· {preview.sourceType} · {preview.sourceTitle}
						{/if}
						{#if preview.model}· {preview.model}{/if}
					</Sheet.Description>
				</Sheet.Header>

				{#if preview.error}
					<p role="alert" class="px-6 pt-4 text-xs text-destructive">{preview.error}</p>
				{/if}

				<div
					class="grid min-h-0 flex-1 grid-cols-1 {previewCandidate
						? 'md:grid-cols-2 md:divide-x'
						: ''} divide-border overflow-y-auto px-6 py-5"
					data-testid="translation-workbench-preview"
				>
					<div class="min-w-0 md:pr-4">
						<p class="mb-2 text-xs text-muted-foreground">
							{m.admin_translations_preview_source()}
						</p>
						<MarkdownRenderer
							source={preview.sourceContent ?? ''}
							class="prose prose-sm max-w-152"
						/>
					</div>
					{#if previewCandidate}
						<div class="mt-6 min-w-0 md:mt-0 md:pl-4">
							<p class="mb-2 text-xs text-muted-foreground">
								{preview.content
									? m.admin_translations_preview_candidate()
									: m.admin_translations_preview_streaming()}
							</p>
							<MarkdownRenderer source={previewCandidate} class="prose prose-sm max-w-152" />
						</div>
					{/if}
				</div>

				<div class="flex items-center justify-between border-t border-border px-6 py-4">
					<span class="text-xs text-muted-foreground">
						{preview.updatedAt
							? formatDateTime(new Date(preview.updatedAt), {
									dateStyle: 'short',
									timeStyle: 'short'
								})
							: ''}
					</span>
					<Button variant="ghost" size="sm" onclick={closePreview}>
						{m.admin_common_close()}
					</Button>
				</div>
			</div>
		</Sheet.Content>
	</Sheet.Root>
{/if}

<DeleteConfirm
	open={deleteTarget !== null}
	title={m.admin_translations_delete_title()}
	description={m.admin_translations_delete_desc({ title: deleteTarget?.title ?? '' })}
	id={deleteTarget?.id ?? ''}
	action="?/delete"
	confirmLabel={m.admin_translations_delete()}
	error={deleteFailure}
	onclose={() => (deleteTarget = null)}
/>

<!-- Same dialog component, no row id: the action deletes every discarded row,
     so the description spells out the count it will remove. -->
<DeleteConfirm
	open={purgeOpen}
	title={m.admin_translations_purge_title()}
	description={m.admin_translations_purge_desc({ count: data.counts.discarded ?? 0 })}
	id=""
	action="?/purgeDiscarded"
	confirmLabel={m.admin_translations_purge()}
	onclose={() => (purgeOpen = false)}
/>

<script lang="ts">
	import { invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { DeleteConfirm } from '$lib/components/admin';
	import {
		ListFilter,
		ListPagination,
		ListRowActions,
		ListSearch,
		ListTable,
		listColumnClass,
		type ListColumn
	} from '$lib/components/admin/list-table';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import { MOMENT_KINDS, type MomentKind } from '$lib/utils/moment-meta';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconThumbDown from '@tabler/icons-svelte-runes/icons/thumb-down';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';

	let { data, form }: PageProps = $props();

	type MomentRow = (typeof data.moments)[number];

	const KIND_LABELS: Record<MomentKind, string> = {
		life: m.admin_moments_kind_life(),
		tech: m.admin_moments_kind_tech(),
		media: m.admin_moments_kind_media(),
		other: m.admin_moments_kind_other()
	};

	/** Mirrors the posts / notes admin lists: one descriptor per column. */
	const cols: Record<'content' | 'kind' | 'votes' | 'created' | 'actions', ListColumn> = {
		content: { id: 'content', label: m.admin_moments_content(), control: true },
		kind: {
			id: 'kind',
			label: m.admin_moments_kind(),
			width: 'w-28',
			hideBelow: 'md',
			control: true
		},
		votes: {
			id: 'votes',
			label: m.admin_list_col_votes(),
			width: 'w-24',
			hideBelow: 'lg',
			align: 'right'
		},
		created: { id: 'created', label: m.admin_list_col_created(), width: 'w-32', hideBelow: 'sm' },
		actions: {
			id: 'actions',
			label: m.admin_common_actions(),
			width: 'w-28',
			align: 'right',
			control: true
		}
	};
	const columns = Object.values(cols);

	const currentKind = $derived(
		data.filters.type && isKindLabel(data.filters.type)
			? KIND_LABELS[data.filters.type as MomentKind]
			: m.admin_list_filter_all_kinds()
	);

	function isKindLabel(value: string): boolean {
		return (MOMENT_KINDS as readonly string[]).includes(value);
	}

	const LIST_PATH = '/admin/moments';

	/** Query string for a filter change; `''` when it clears every filter. */
	function querySearch(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			type: data.filters.type || undefined,
			keyword: data.filters.keyword || undefined,
			...patch
		};
		for (const [key, value] of Object.entries(next)) {
			if (value) params.set(key, value);
		}
		const qs = params.toString();
		return qs ? `?${qs}` : '';
	}

	function pageHref(target: number): string {
		const params = new SvelteURLSearchParams();
		if (data.filters.type) params.set('type', data.filters.type);
		if (data.filters.keyword) params.set('keyword', data.filters.keyword);
		if (target > 1) params.set('page', String(target));
		const qs = params.toString();
		return `${resolve(LIST_PATH)}${qs ? `?${qs}` : ''}`;
	}

	const searchHidden = $derived(
		Object.fromEntries(
			([['type', data.filters.type]] as const).filter(([, value]) => Boolean(value))
		)
	);

	const kindOptions = $derived([
		{
			value: '',
			label: m.admin_list_filter_all_kinds(),
			search: querySearch({ type: undefined })
		},
		...MOMENT_KINDS.map((kind) => ({
			value: kind,
			label: KIND_LABELS[kind],
			search: querySearch({ type: kind })
		}))
	]);

	// ── One-shot "saved" flash ──
	// The editor redirects back with `?saved=1`; consume the param so a
	// refresh / back-nav cannot replay the banner (same shape as files-list).
	let flashSaved = $state(false);
	$effect(() => {
		if (page.url.searchParams.get('saved') === '1') {
			flashSaved = true;
			const url = new URL(page.url);
			url.searchParams.delete('saved');
			replaceState(url, {});
		}
	});

	// ── Delete confirm ──
	let deleteTarget = $state<MomentRow | null>(null);

	function openDelete(row: MomentRow) {
		dismissError();
		deleteTarget = row;
	}

	// Secondary row action folded into the overflow menu.
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyContent(row: MomentRow) {
		try {
			await navigator.clipboard.writeText(row.content);
			copiedId = row.id;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copiedId = null), 1800);
		} catch {
			// Clipboard unavailable (insecure context / denied).
		}
	}

	// Round-4 review: a page-form error belongs to the action that produced
	// it; any older failure is dismissed when a dialog opens (a fresh result
	// is a new `form` object and re-enables the message).
	let errorDismissedFor: unknown = null;

	const errorMessage = $derived(
		form && form !== errorDismissedFor && 'error' in form && typeof form.error === 'string'
			? form.error
			: null
	);

	function dismissError() {
		errorDismissedFor = form;
	}
</script>

<svelte:head>
	<title>{m.admin_moments_title()} - Lair Admin</title>
</svelte:head>

<!-- One-shot save confirmation from the editor redirect. -->
{#if flashSaved}
	<div
		class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
	>
		{m.admin_moments_edit_saved()}
	</div>
{/if}

<DeleteConfirm
	open={deleteTarget !== null}
	title={m.admin_moments_delete_title()}
	description={m.admin_moments_delete_desc()}
	id={deleteTarget?.id ?? ''}
	error={errorMessage}
	onclose={() => (deleteTarget = null)}
/>

<ListTable
	{columns}
	rows={data.moments}
	rowKey={(row) => row.id}
	label={m.admin_moments_list_aria()}
	class="min-h-96"
>
	{#snippet header(col)}
		{#if col.id === 'content'}
			<ListSearch
				path={LIST_PATH}
				label={m.admin_moments_search_label()}
				placeholder={m.admin_moments_search_ph()}
				value={data.filters.keyword}
				hidden={searchHidden}
				clearSearch={querySearch({ keyword: undefined })}
			/>
		{:else if col.id === 'kind'}
			<ListFilter
				path={LIST_PATH}
				label={col.label}
				current={currentKind}
				selected={data.filters.type}
				options={kindOptions}
			/>
		{:else if col.id === 'actions'}
			<RefreshButton onclick={() => invalidateAll()} />
		{/if}
	{/snippet}

	{#snippet row(moment)}
		<Table.Cell class={cn(listColumnClass(cols.content), 'whitespace-normal')}>
			<p class="line-clamp-3 text-sm wrap-break-word whitespace-pre-wrap">{moment.excerpt}</p>
		</Table.Cell>
		<Table.Cell class={listColumnClass(cols.kind)}>
			<Badge variant="secondary" class="text-xs">
				{KIND_LABELS[moment.type as MomentKind] ?? moment.type}
			</Badge>
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.votes), 'text-right')}>
			<div class="flex items-center justify-end gap-2 text-xs text-muted-foreground">
				<span class="inline-flex items-center gap-1">
					<IconThumbUp class="size-3.5" aria-hidden="true" />
					<span class="sr-only">{m.admin_moments_upvote()}</span>{moment.up}
				</span>
				<span class="inline-flex items-center gap-1">
					<IconThumbDown class="size-3.5" aria-hidden="true" />
					<span class="sr-only">{m.admin_moments_downvote()}</span>{moment.down}
				</span>
			</div>
		</Table.Cell>
		<Table.Cell
			class={cn(listColumnClass(cols.created), 'text-xs whitespace-nowrap text-muted-foreground')}
		>
			{formatDateTime(new Date(moment.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
			<ListRowActions
				editPath="/admin/moments/edit"
				editId={moment.id}
				editLabel={m.admin_moments_edit()}
				deleteLabel={m.admin_moments_delete_title()}
				onDelete={() => openDelete(moment)}
			>
				{#snippet more()}
					<DropdownMenu.Item onclick={() => copyContent(moment)}>
						{#if copiedId === moment.id}
							<IconCheck data-icon="inline-start" />
						{:else}
							<IconCopy data-icon="inline-start" />
						{/if}
						{copiedId === moment.id ? m.admin_list_copied() : m.admin_list_copy_content()}
					</DropdownMenu.Item>
				{/snippet}
			</ListRowActions>
			<span class="sr-only" aria-live="polite">
				{copiedId === moment.id ? m.admin_list_copied() : ''}
			</span>
		</Table.Cell>
	{/snippet}

	{#snippet empty()}
		<Empty class="mx-auto py-14">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">
					{data.filters.keyword || data.filters.type
						? m.admin_moments_empty_filtered()
						: m.admin_moments_empty()}
				</h3>
				{#if !data.filters.keyword && !data.filters.type}
					<p class="text-sm text-muted-foreground">{m.admin_moments_empty_desc()}</p>
				{/if}
			</div>
			<div class="mt-2">
				<Button href="/admin/moments/edit">
					<IconPlus data-icon="inline-start" />
					{m.admin_common_new()}
				</Button>
			</div>
		</Empty>
	{/snippet}

	{#snippet footer()}
		<ListPagination total={data.totalCount} page={data.page} pageSize={data.pageSize} {pageHref} />
	{/snippet}
</ListTable>

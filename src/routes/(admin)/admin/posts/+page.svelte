<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
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
		listColumnClass
	} from '$lib/components/admin/list-table';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { cols, columns } from './columns';
	import { tick } from 'svelte';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';

	let { data, form }: PageProps = $props();

	type PostRow = (typeof data.posts)[number];

	/** Failure from `?/status` - shown in the confirm dialog and in the banner. */
	const actionError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);

	const STATUS_LABELS: Record<string, string> = {
		published: m.admin_posts_status_published(),
		draft: m.admin_posts_status_draft(),
		scheduled: m.admin_posts_status_scheduled(),
		trash: m.admin_posts_status_trash()
	};

	/**
	 * Column descriptors are the single source of truth: `listColumnClass`
	 * derives both the `<th>` and the `<td>` classes from the same entry, so a
	 * column can never be half-visible (the old list's overlap bug).
	 */
	/**
	 * Row layout. The title owns line 1 and wraps in full - it is the record's
	 * identity, and truncating it costs more than the width it saves. Everything
	 * else is deferred under it, one related group per line:
	 *
	 *   line 2 归属        category / status - only once their column has dropped
	 *   line 3 计量 / 时间  views / likes / updated - never columns at all
	 *
	 * Narrowing costs columns, never information: a dropped column value shows on
	 * line 2 at exactly the widths where its `<th>` is hidden, and its filter moves
	 * in beside the search box so it stays usable. Dropping order when narrowing is
	 * 状态 -> 分类 - among filters the more used one survives longer, and the title
	 * search never moves.
	 */

	const currentCategory = $derived(
		data.categories.find((c) => c.id === data.filters.category)?.name ??
			m.admin_posts_filter_all_categories()
	);
	const currentStatus = $derived(
		data.filters.status && STATUS_LABELS[data.filters.status]
			? STATUS_LABELS[data.filters.status]
			: m.admin_posts_filter_all_status()
	);

	const LIST_PATH = '/admin/posts';
	const EDIT_PATH = '/admin/posts/edit';

	/** Query string for a filter change; `''` when it clears every filter. */
	function querySearch(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			status: data.filters.status || undefined,
			category: data.filters.category || undefined,
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
		if (data.filters.status) params.set('status', data.filters.status);
		if (data.filters.category) params.set('category', data.filters.category);
		if (data.filters.keyword) params.set('keyword', data.filters.keyword);
		if (target > 1) params.set('page', String(target));
		const qs = params.toString();
		return `${resolve(LIST_PATH)}${qs ? `?${qs}` : ''}`;
	}

	/** Filters the search form must carry over on submit. */
	const searchHidden = $derived(
		Object.fromEntries(
			(
				[
					['status', data.filters.status],
					['category', data.filters.category]
				] as const
			).filter(([, value]) => Boolean(value))
		)
	);

	const categoryOptions = $derived([
		{
			value: '',
			label: m.admin_posts_filter_all_categories(),
			search: querySearch({ category: undefined })
		},
		...data.categories.map((cat) => ({
			value: cat.id,
			label: cat.name,
			search: querySearch({ category: cat.id })
		}))
	]);

	const statusOptions = $derived([
		{
			value: '',
			label: m.admin_posts_filter_all_status(),
			search: querySearch({ status: undefined })
		},
		...Object.entries(STATUS_LABELS).map(([value, label]) => ({
			value,
			label,
			search: querySearch({ status: value })
		}))
	]);

	// Row actions: edit and trash sit on the row itself (the common ones); the
	// utilities are folded into the overflow menu.
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	type LangChainEntry = {
		lang: string;
		state: 'source' | 'published' | 'draft' | 'scheduled' | 'trash' | 'missing';
		id: string | null;
	};

	/**
	 * The family at a glance: source first, then its translations, then the
	 * languages that have no row yet - `zh-cn·源 -> en·草稿  ja·未译`. The editor
	 * shows the same chain, so the list and the editor agree on the shape.
	 */
	function langChain(post: PostRow): LangChainEntry[] {
		const present = new Set(post.langs.map((l) => l.lang));
		const stateOf = (l: { status: string; isSource: boolean }): LangChainEntry['state'] => {
			if (l.isSource) return 'source';
			if (l.status === 'published') return 'published';
			if (l.status === 'scheduled') return 'scheduled';
			if (l.status === 'trash') return 'trash';
			return 'draft';
		};
		const source = post.langs.filter((l) => l.isSource);
		const others = post.langs
			.filter((l) => !l.isSource)
			.sort((a, b) => a.lang.localeCompare(b.lang));
		const missing = data.langs
			.filter((l) => !present.has(l))
			.map((l) => ({ lang: l, status: 'missing', id: null, hasDraft: false, isSource: false }));
		return [...source, ...others, ...missing].map((l) => ({
			lang: l.lang,
			state: l.status === 'missing' ? 'missing' : stateOf(l),
			id: l.id ?? null
		}));
	}

	function langEntryLabel(entry: LangChainEntry): string {
		const suffix =
			entry.state === 'source'
				? m.admin_posts_edit_lang_source()
				: entry.state === 'missing'
					? m.admin_posts_edit_lang_missing()
					: entry.state === 'published'
						? m.admin_posts_status_published()
						: entry.state === 'scheduled'
							? m.admin_posts_status_scheduled()
							: entry.state === 'trash'
								? m.admin_posts_status_trash()
								: m.admin_posts_status_draft();
		return `${entry.lang}·${suffix}`;
	}

	async function copyLink(post: PostRow) {
		try {
			await navigator.clipboard.writeText(new URL(`/${post.slug}`, location.origin).toString());
			copiedId = post.id;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copiedId = null), 1800);
		} catch {
			// Clipboard unavailable (insecure context / denied) - the link is
			// still reachable through the open-in-new-tab item in the same menu.
		}
	}

	// Both confirmable row actions share one dialog. Permanent delete only shows
	// up in the overflow menu of a row that is already in the trash, so losing
	// data takes two deliberate steps and a mis-click cannot do it.
	type Pending = { id: string; kind: 'trash' | 'purge'; familySize?: number };

	let pending = $state<Pending | null>(null);
	let restoreId = $state('');
	let statusForm = $state<HTMLFormElement | null>(null);

	const pendingCopy = $derived(
		pending?.kind === 'purge'
			? {
					title: m.admin_list_purge_title(),
					description:
						(pending.familySize ?? 1) > 1
							? m.admin_posts_purge_family_desc({ count: pending.familySize ?? 1 })
							: m.admin_list_purge_desc(),
					confirmLabel: m.admin_list_purge(),
					action: '?/purge',
					extraFields: {} as Record<string, string>
				}
			: {
					title: m.admin_list_trash_title(),
					description: m.admin_list_trash_desc(),
					confirmLabel: m.admin_list_trash(),
					action: '?/status',
					extraFields: { action: 'trash' } as Record<string, string>
				}
	);

	function openTrash(post: PostRow) {
		pending = { id: post.id, kind: 'trash' };
	}

	function openPurge(post: PostRow) {
		pending = { id: post.id, kind: 'purge', familySize: post.langs.length };
	}

	async function restore(post: PostRow) {
		restoreId = post.id;
		await tick();
		statusForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{m.admin_posts_title()} - Lair Admin</title>
</svelte:head>

{#if actionError}
	<div
		role="alert"
		class="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
	>
		{actionError}
	</div>
{/if}

<ListTable
	{columns}
	rows={data.posts}
	rowKey={(post) => post.id}
	label={m.admin_posts_title()}
	class="min-h-96"
>
	{#snippet header(col)}
		{#if col.id === 'title'}
			<ListSearch
				path={LIST_PATH}
				label={m.admin_list_search_label()}
				placeholder={m.admin_posts_search_placeholder()}
				value={data.filters.keyword}
				hidden={searchHidden}
				clearSearch={querySearch({ keyword: undefined })}
			/>
		{:else if col.id === 'category'}
			<ListFilter
				path={LIST_PATH}
				label={col.label}
				current={currentCategory}
				selected={data.filters.category}
				options={categoryOptions}
			/>
		{:else if col.id === 'status'}
			<ListFilter
				path={LIST_PATH}
				label={col.label}
				current={currentStatus}
				selected={data.filters.status}
				options={statusOptions}
			/>
		{:else if col.id === 'actions'}
			<RefreshButton onclick={() => invalidateAll()} />
		{/if}
	{/snippet}

	{#snippet row(post)}
		{@const chain = langChain(post)}
		<Table.Cell class={cn(listColumnClass(cols.title), 'whitespace-normal')}>
			<div class="flex min-w-0 flex-col gap-1">
				<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<a
						href="{resolve(EDIT_PATH)}?id={post.id}"
						class="min-w-0 truncate font-medium hover:text-primary"
					>
						{post.title || m.admin_posts_untitled()}
					</a>
					{#if post.hasDraft}
						<Badge variant="secondary" class="shrink-0 text-xs"
							>{m.admin_posts_unpublished_changes()}</Badge
						>
					{/if}
				</div>
				<!-- Translation family: source -> translations -> missing. -->
				<div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
					{#each chain as entry, i (entry.lang)}
						{#if i === 1 && chain[0]?.state === 'source'}
							<span aria-hidden="true" class="text-muted-foreground">→</span>
						{/if}
						<a
							href={entry.id ? `${resolve(EDIT_PATH)}?id=${entry.id}` : `${resolve(EDIT_PATH)}`}
							class="shrink-0"
						>
							<Badge
								variant={entry.state === 'source'
									? 'default'
									: entry.state === 'missing'
										? 'outline'
										: entry.state === 'trash'
											? 'destructive'
											: entry.state === 'published'
												? 'outline'
												: 'secondary'}
								class="text-xs {entry.state === 'missing' ? 'border-dashed opacity-70' : ''}"
							>
								{langEntryLabel(entry)}
							</Badge>
						</a>
					{/each}
				</div>
				<!-- Below xl the columns this meta covers are hidden. -->
				<div
					class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground xl:hidden"
				>
					<span class="truncate">{post.categoryName ?? '—'}</span>
					<Badge
						variant={post.status === 'published'
							? 'default'
							: post.status === 'trash'
								? 'destructive'
								: 'secondary'}
						class="text-xs"
					>
						{STATUS_LABELS[post.status] ?? post.status}
					</Badge>
					<span class="inline-flex items-center gap-1"
						><IconEye class="size-3" />{post.readCount}</span
					>
					<span class="inline-flex items-center gap-1"
						><IconThumbUp class="size-3" />{post.likeCount}</span
					>
					<span
						>{formatDateTime(new Date(post.updatedAt ?? post.createdAt), {
							dateStyle: 'short'
						})}</span
					>
				</div>
			</div>
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.category), 'text-xs text-muted-foreground')}>
			<span class="truncate">{post.categoryName ?? '—'}</span>
		</Table.Cell>
		<Table.Cell class={listColumnClass(cols.status)}>
			<Badge
				variant={post.status === 'published'
					? 'default'
					: post.status === 'trash'
						? 'destructive'
						: 'secondary'}
				class="text-xs"
			>
				{STATUS_LABELS[post.status] ?? post.status}
			</Badge>
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.views), 'text-right text-xs text-muted-foreground')}>
			{post.readCount}
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.likes), 'text-right text-xs text-muted-foreground')}>
			{post.likeCount}
		</Table.Cell>
		<Table.Cell
			class={cn(listColumnClass(cols.updated), 'text-xs whitespace-nowrap text-muted-foreground')}
		>
			{formatDateTime(new Date(post.updatedAt ?? post.createdAt), {
				dateStyle: 'short',
				timeStyle: 'short'
			})}
		</Table.Cell>
		<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
			<ListRowActions
				editPath={EDIT_PATH}
				editId={post.id}
				editLabel={m.admin_common_edit()}
				deleteIcon={post.status === 'trash' ? 'restore' : 'trash'}
				deleteLabel={post.status === 'trash' ? m.admin_list_restore() : m.admin_list_trash()}
				onDelete={() => {
					if (post.status === 'trash') restore(post);
					else openTrash(post);
				}}
			>
				{#snippet more()}
					<DropdownMenu.Item onclick={() => window.open(`/${post.slug}`, '_blank', 'noopener')}>
						<IconExternalLink data-icon="inline-start" />
						{m.admin_posts_open_new_tab()}
					</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => copyLink(post)}>
						{#if copiedId === post.id}
							<IconCheck data-icon="inline-start" />
						{:else}
							<IconLink data-icon="inline-start" />
						{/if}
						{copiedId === post.id ? m.admin_list_copied() : m.admin_posts_copy_link()}
					</DropdownMenu.Item>
					{#if post.status === 'trash'}
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							onclick={() => openPurge(post)}
							class="text-destructive focus:text-destructive"
						>
							<IconTrash data-icon="inline-start" />
							{m.admin_list_purge()}
						</DropdownMenu.Item>
					{/if}
				{/snippet}
			</ListRowActions>
			<span class="sr-only" aria-live="polite">
				{copiedId === post.id ? m.admin_list_copied() : ''}
			</span>
		</Table.Cell>
	{/snippet}

	{#snippet empty()}
		<Empty class="mx-auto py-14">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">{m.admin_posts_empty_title()}</h3>
				<p class="text-sm text-muted-foreground">
					{data.filters.keyword || data.filters.status || data.filters.category
						? m.admin_posts_empty_filtered()
						: m.admin_posts_empty_hint()}
				</p>
			</div>
			<div class="mt-2">
				<Button href={resolve(EDIT_PATH)}>
					<IconPlus data-icon="inline-start" />
					{m.admin_posts_new()}
				</Button>
			</div>
		</Empty>
	{/snippet}

	{#snippet footer()}
		<ListPagination total={data.totalCount} page={data.page} pageSize={data.pageSize} {pageHref} />
	{/snippet}
</ListTable>

<DeleteConfirm
	open={pending !== null}
	title={pendingCopy.title}
	description={pendingCopy.description}
	id={pending?.id ?? ''}
	action={pendingCopy.action}
	extraFields={pendingCopy.extraFields}
	confirmLabel={pendingCopy.confirmLabel}
	error={actionError}
	onclose={() => (pending = null)}
/>

<!-- Restore is reversible, so it needs no confirm - just the submit. -->
<form method="POST" action="?/status" use:enhance bind:this={statusForm} class="hidden">
	<input type="hidden" name="id" value={restoreId} />
	<input type="hidden" name="action" value="restore" />
</form>

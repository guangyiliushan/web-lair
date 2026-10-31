<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll, afterNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { tick } from 'svelte';
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
	import { noteMoodLabel, NOTE_WEATHER } from '$lib/utils/note-meta';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { cols, columns } from './columns';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconThumbUp from '@tabler/icons-svelte-runes/icons/thumb-up';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';

	let { data, form }: PageProps = $props();

	type NoteRow = (typeof data.notes)[number];

	/** Failure from `?/status` - shown in the confirm dialog and in the banner. */
	const actionError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);

	const LIST_PATH = '/admin/notes';
	const EDIT_PATH = '/admin/notes/edit';

	// Transient banner for ?trashed=1 / ?discarded=1 (the edit page consumes
	// its own variants; without this the redirects landed silently -
	// review finding).
	let flash = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	afterNavigate(() => {
		// A copy: `page.url` is reactive and must not be mutated in place.
		const params = new SvelteURLSearchParams(page.url.searchParams);
		const message =
			params.get('trashed') === '1'
				? m.admin_notes_flash_trashed()
				: params.get('discarded') === '1'
					? m.admin_posts_edit_flash_discarded()
					: null;
		if (!message) return;
		flash = message;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 3500);
		params.delete('trashed');
		params.delete('discarded');
		replaceState(resolve(`${LIST_PATH}?${params.toString()}`), {});
	});

	const STATUS_LABELS: Record<string, string> = {
		published: m.admin_posts_status_published(),
		draft: m.admin_posts_status_draft(),
		private: m.admin_notes_status_private(),
		scheduled: m.admin_posts_status_scheduled(),
		trash: m.admin_posts_status_trash()
	};

	/**
	 * Filterable statuses = the server whitelist. `scheduled` stays out until a
	 * scheduling UI writes such rows; offering it used to answer an unfiltered
	 * list while claiming a filter was active (round-7 review finding).
	 */
	const FILTERABLE_STATUSES = ['published', 'draft', 'private', 'trash'] as const;

	const currentTopic = $derived(
		data.topics.find((t) => t.id === data.filters.topic)?.name ?? m.admin_notes_all_topics()
	);
	const currentStatus = $derived(
		(FILTERABLE_STATUSES as readonly string[]).includes(data.filters.status)
			? STATUS_LABELS[data.filters.status]
			: m.admin_posts_filter_all_status()
	);

	function weatherLabel(code: number | null): string | null {
		if (code === null || code === undefined) return null;
		return NOTE_WEATHER[code]?.labels[getLocale()] ?? String(code);
	}

	/** Query string for a filter change; `''` when it clears every filter. */
	function querySearch(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			status: data.filters.status || undefined,
			topic: data.filters.topic || undefined,
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
		if (data.filters.topic) params.set('topic', data.filters.topic);
		if (data.filters.keyword) params.set('keyword', data.filters.keyword);
		if (target > 1) params.set('page', String(target));
		const qs = params.toString();
		return `${resolve(LIST_PATH)}${qs ? `?${qs}` : ''}`;
	}

	const searchHidden = $derived(
		Object.fromEntries(
			(
				[
					['status', data.filters.status],
					['topic', data.filters.topic]
				] as const
			).filter(([, value]) => Boolean(value))
		)
	);

	const topicOptions = $derived([
		{ value: '', label: m.admin_notes_all_topics(), search: querySearch({ topic: undefined }) },
		...data.topics.map((topic) => ({
			value: topic.id,
			label: topic.name,
			search: querySearch({ topic: topic.id })
		}))
	]);

	const statusOptions = $derived([
		{
			value: '',
			label: m.admin_posts_filter_all_status(),
			search: querySearch({ status: undefined })
		},
		...FILTERABLE_STATUSES.map((value) => ({
			value,
			label: STATUS_LABELS[value],
			search: querySearch({ status: value })
		}))
	]);

	function publicHref(note: NoteRow): string {
		return `/${note.lang}/notes/${note.slug}`;
	}

	// Row actions: edit and trash sit on the row itself (the common ones); the
	// utilities are folded into the overflow menu.
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	type LangChainEntry = {
		lang: string;
		state: 'source' | 'published' | 'draft' | 'private' | 'scheduled' | 'trash' | 'missing';
		id: string | null;
	};

	/**
	 * The family at a glance: source first, then its translations, then the
	 * languages that have no row yet - the same chain the posts list and both
	 * editors show, so all three agree on the shape.
	 */
	function langChain(note: NoteRow): LangChainEntry[] {
		const present = new Set(note.langs.map((l) => l.lang));
		const stateOf = (l: { status: string; isSource: boolean }): LangChainEntry['state'] => {
			if (l.isSource) return 'source';
			if (l.status === 'published') return 'published';
			if (l.status === 'private') return 'private';
			if (l.status === 'scheduled') return 'scheduled';
			if (l.status === 'trash') return 'trash';
			return 'draft';
		};
		const source = note.langs.filter((l) => l.isSource);
		const others = note.langs
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
		if (entry.state === 'source') {
			return `${entry.lang}·${m.admin_posts_edit_lang_source()}`;
		}
		if (entry.state === 'missing') {
			return `${entry.lang}·${m.admin_posts_edit_lang_missing()}`;
		}
		return `${entry.lang}·${STATUS_LABELS[entry.state] ?? entry.state}`;
	}

	async function copyLink(note: NoteRow) {
		try {
			await navigator.clipboard.writeText(new URL(publicHref(note), location.origin).toString());
			copiedId = note.id;
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
	type Pending = { id: string; kind: 'trash' | 'purge' };

	let pending = $state<Pending | null>(null);
	let restoreId = $state('');
	let statusForm = $state<HTMLFormElement | null>(null);

	const pendingCopy = $derived(
		pending?.kind === 'purge'
			? {
					title: m.admin_list_purge_title(),
					description: m.admin_list_purge_desc(),
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

	function openTrash(note: NoteRow) {
		pending = { id: note.id, kind: 'trash' };
	}

	function openPurge(note: NoteRow) {
		pending = { id: note.id, kind: 'purge' };
	}

	async function restore(note: NoteRow) {
		restoreId = note.id;
		await tick();
		statusForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{m.admin_notes_title()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-4">
	{#if flash}
		<div
			role="status"
			class="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
		>
			{flash}
		</div>
	{/if}
	{#if actionError}
		<div
			role="alert"
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{actionError}
		</div>
	{/if}

	<ListTable
		{columns}
		rows={data.notes}
		rowKey={(note) => note.id}
		label={m.admin_notes_title()}
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
			{:else if col.id === 'topic'}
				<ListFilter
					path={LIST_PATH}
					label={col.label}
					current={currentTopic}
					selected={data.filters.topic}
					options={topicOptions}
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

		{#snippet row(note)}
			{@const chain = langChain(note)}
			{@const moodText = note.mood ? noteMoodLabel(note.mood as never, getLocale()) : null}
			{@const weatherText = weatherLabel(note.weatherCode)}
			{@const temperatureText = note.temperatureC ? `${note.temperatureC}°C` : null}
			<Table.Cell class={cn(listColumnClass(cols.title), 'whitespace-normal')}>
				<div class="flex min-w-0 flex-col gap-1">
					<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<a
							href="{resolve(EDIT_PATH)}?id={note.id}"
							class="min-w-0 truncate font-medium hover:text-primary"
						>
							{note.title || m.admin_posts_untitled()}
						</a>
						{#if note.hasDraft}
							<Badge variant="secondary" class="shrink-0 text-xs"
								>{m.admin_posts_unpublished_changes()}</Badge
							>
						{/if}
						{#if note.locked}
							<IconLock
								class="size-3.5 shrink-0 text-muted-foreground"
								role="img"
								aria-label={m.notes_locked()}
							/>
						{/if}
						{#if note.pinned}
							<IconPin
								class="size-3.5 shrink-0 text-primary/70"
								role="img"
								aria-label={m.admin_notes_pinned()}
							/>
						{/if}
					</div>
					<!-- Translation family: source -> translations -> missing. -->
					<div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
						{#each chain as entry, i (entry.lang)}
							{#if i === 1 && chain[0]?.state === 'source'}
								<span aria-hidden="true" class="text-muted-foreground">→</span>
							{/if}
							<a
								href={entry.id ? `${resolve(EDIT_PATH)}?id=${entry.id}` : resolve(EDIT_PATH)}
								class="shrink-0"
							>
								<Badge
									variant={entry.state === 'source'
										? 'default'
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
						<span class="font-mono">#{note.nid}</span>
						<span class="truncate">{note.topicName ?? '—'}</span>
						<Badge
							variant={note.status === 'published'
								? 'default'
								: note.status === 'trash'
									? 'destructive'
									: 'secondary'}
							class="text-xs"
						>
							{STATUS_LABELS[note.status] ?? note.status}
						</Badge>
						<span class="inline-flex items-center gap-1"
							><IconEye class="size-3" />{note.readCount}</span
						>
						<span class="inline-flex items-center gap-1"
							><IconThumbUp class="size-3" />{note.likeCount}</span
						>
						<span
							>{formatDateTime(new Date(note.updatedAt ?? note.createdAt), {
								dateStyle: 'short'
							})}</span
						>
					</div>
				</div>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.id), 'font-mono text-xs text-muted-foreground')}>
				#{note.nid}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.topic), 'text-xs text-muted-foreground')}>
				{#if note.topicName}
					<Badge variant="outline" class="text-xs">{note.topicName}</Badge>
				{:else}
					—
				{/if}
			</Table.Cell>
			<Table.Cell class={listColumnClass(cols.status)}>
				<Badge
					variant={note.status === 'published'
						? 'default'
						: note.status === 'trash'
							? 'destructive'
							: 'secondary'}
					class="text-xs"
				>
					{STATUS_LABELS[note.status] ?? note.status}
				</Badge>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.meta), 'text-xs text-muted-foreground')}>
				<div class="flex min-w-0 items-center gap-1.5">
					{#if !moodText && !weatherText && !temperatureText}
						<span class="truncate">—</span>
					{:else}
						{#if moodText}
							<span class="truncate">{moodText}</span>
						{/if}
						{#if weatherText || temperatureText}
							<span class="truncate">
								{weatherText ?? ''}{weatherText && temperatureText ? ' · ' : ''}{temperatureText ??
									''}
							</span>
						{/if}
					{/if}
				</div>
			</Table.Cell>
			<Table.Cell
				class={cn(listColumnClass(cols.views), 'text-right text-xs text-muted-foreground')}
			>
				{note.readCount}
			</Table.Cell>
			<Table.Cell
				class={cn(listColumnClass(cols.likes), 'text-right text-xs text-muted-foreground')}
			>
				{note.likeCount}
			</Table.Cell>
			<Table.Cell
				class={cn(listColumnClass(cols.updated), 'text-xs whitespace-nowrap text-muted-foreground')}
			>
				{formatDateTime(new Date(note.updatedAt ?? note.createdAt), {
					dateStyle: 'short',
					timeStyle: 'short'
				})}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
				<ListRowActions
					editPath={EDIT_PATH}
					editId={note.id}
					editLabel={m.admin_common_edit()}
					deleteIcon={note.status === 'trash' ? 'restore' : 'trash'}
					deleteLabel={note.status === 'trash' ? m.admin_list_restore() : m.admin_list_trash()}
					onDelete={() => {
						if (note.status === 'trash') restore(note);
						else openTrash(note);
					}}
				>
					{#snippet more()}
						<DropdownMenu.Item onclick={() => window.open(publicHref(note), '_blank', 'noopener')}>
							<IconExternalLink data-icon="inline-start" />
							{m.admin_posts_open_new_tab()}
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => copyLink(note)}>
							{#if copiedId === note.id}
								<IconCheck data-icon="inline-start" />
							{:else}
								<IconLink data-icon="inline-start" />
							{/if}
							{copiedId === note.id ? m.admin_list_copied() : m.admin_posts_copy_link()}
						</DropdownMenu.Item>
						{#if note.status === 'trash'}
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								onclick={() => openPurge(note)}
								class="text-destructive focus:text-destructive"
							>
								<IconTrash data-icon="inline-start" />
								{m.admin_list_purge()}
							</DropdownMenu.Item>
						{/if}
					{/snippet}
				</ListRowActions>
				<span class="sr-only" aria-live="polite">
					{copiedId === note.id ? m.admin_list_copied() : ''}
				</span>
			</Table.Cell>
		{/snippet}

		{#snippet empty()}
			<Empty class="mx-auto py-14">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">{m.admin_notes_empty()}</h3>
					<p class="text-sm text-muted-foreground">
						{data.filters.keyword || data.filters.status || data.filters.topic
							? m.admin_notes_empty_filtered()
							: m.admin_notes_empty_all()}
					</p>
				</div>
				<div class="mt-2">
					<Button href={resolve(EDIT_PATH)}>
						<IconPlus data-icon="inline-start" />
						{m.admin_notes_new()}
					</Button>
				</div>
			</Empty>
		{/snippet}

		{#snippet footer()}
			<ListPagination
				total={data.totalCount}
				page={data.page}
				pageSize={data.pageSize}
				{pageHref}
			/>
		{/snippet}
	</ListTable>
</div>

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

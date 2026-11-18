<script lang="ts">
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { UploadOutcome } from '$lib/utils/upload-each';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { MediaUploadDialog } from '$lib/components/admin/media-upload';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import {
		ListFilter,
		ListRowActions,
		ListSearch,
		ListTable,
		listColumnClass
	} from '$lib/components/admin/list-table';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import { variantKeyFor } from '$lib/media/keys';
	import { formatBytes } from '$lib/utils/format';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { cols, columns } from './columns';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconFile from '@tabler/icons-svelte-runes/icons/file';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';

	let { data, form }: PageProps = $props();

	type FileRow = (typeof data.files)[number];
	type AuditReport = {
		generatedAt: string;
		orphans: Array<{ objectKey: string; fileName: string; status: string; ageDays: number }>;
		brokenLinks: Array<{ refType: string; refId: string; key: string }>;
		missingObjects: Array<{ objectKey: string; fileName: string }>;
		truncated?: boolean;
	};
	type PurgeList = Array<{ objectKey: string; fileName: string; status: string; ageDays: number }>;

	const actionData = $derived(
		(form ?? {}) as {
			message?: string;
			galleryAdded?: { kind: string; slug: string | null };
			audit?: AuditReport;
			purge?: PurgeList;
		}
	);

	let deleteTarget = $state<{ id: string; name: string } | null>(null);

	const LIST_PATH = '/admin/files';

	// Same column descriptor as every other admin list: head and cells share it.
	// Each of the five filters sits in the head cell of the column it drives —
	// the head is two rows here because five bare controls in one line is too
	// tight to read.
	/** Query string for a filter change; `''` when it clears every filter. */
	function querySearch(patch: Record<string, string | undefined>): string {
		const params = new SvelteURLSearchParams();
		const next = {
			kind: data.filters.kind || undefined,
			status: data.filters.status || undefined,
			keyword: data.filters.keyword || undefined,
			since: data.filters.since || undefined,
			orphan: data.filters.orphan ? '1' : undefined,
			...patch
		};
		for (const [key, value] of Object.entries(next)) {
			if (value) params.set(key, value);
		}
		const qs = params.toString();
		return qs ? `?${qs}` : '';
	}

	const searchHidden = $derived(
		Object.fromEntries(
			(
				[
					['kind', data.filters.kind],
					['status', data.filters.status],
					['since', data.filters.since],
					['orphan', data.filters.orphan ? '1' : '']
				] as const
			).filter(([, value]) => Boolean(value))
		)
	);

	const currentKind = $derived(
		data.filters.kind === 'image'
			? m.admin_files_kind_image()
			: data.filters.kind === 'file'
				? m.admin_files_kind_file()
				: m.admin_media_filter_all()
	);
	const kindOptions = $derived([
		{ value: '', label: m.admin_media_filter_all(), search: querySearch({ kind: undefined }) },
		{ value: 'image', label: m.admin_files_kind_image(), search: querySearch({ kind: 'image' }) },
		{ value: 'file', label: m.admin_files_kind_file(), search: querySearch({ kind: 'file' }) }
	]);

	const STATUS_LABELS: Record<string, string> = {
		pending: m.admin_files_status_pending(),
		attached: m.admin_files_status_attached(),
		detached: m.admin_files_status_detached()
	};
	const currentStatus = $derived(STATUS_LABELS[data.filters.status] ?? m.admin_media_filter_all());
	const statusOptions = $derived([
		{ value: '', label: m.admin_media_filter_all(), search: querySearch({ status: undefined }) },
		...(['pending', 'attached', 'detached'] as const).map((value) => ({
			value,
			label: STATUS_LABELS[value],
			search: querySearch({ status: value })
		}))
	]);

	const SINCE_LABELS: Record<string, string> = {
		'7d': m.admin_media_last_7d(),
		'30d': m.admin_media_last_30d(),
		'90d': m.admin_media_last_90d()
	};
	const currentSince = $derived(SINCE_LABELS[data.filters.since] ?? m.admin_media_filter_all());
	const sinceOptions = $derived([
		{ value: '', label: m.admin_media_filter_all(), search: querySearch({ since: undefined }) },
		...(['7d', '30d', '90d'] as const).map((value) => ({
			value,
			label: SINCE_LABELS[value],
			search: querySearch({ since: value })
		}))
	]);

	const currentOrphan = $derived(
		data.filters.orphan ? m.admin_files_orphan_only() : m.admin_media_filter_all()
	);
	const orphanOptions = $derived([
		{ value: '', label: m.admin_media_filter_all(), search: querySearch({ orphan: undefined }) },
		{ value: '1', label: m.admin_files_orphan_only(), search: querySearch({ orphan: '1' }) }
	]);

	// "Add to gallery" is a form action; the overflow item submits one shared form.
	let galleryId = $state('');
	let galleryForm = $state<HTMLFormElement | null>(null);

	async function addGallery(id: string) {
		galleryId = id;
		await tick();
		galleryForm?.requestSubmit();
	}
	let copiedId = $state<string | null>(null);

	// The "上传" header button is declared in +page.server.ts; bind it to the dialog.
	const headerActions = useAdminHeaderActionRegistry();
	let uploadOpen = $state(false);
	$effect(() => headerActions?.register('files:upload', () => (uploadOpen = true)));

	/** Content-addressed registry: flag a byte-identical pick so the row is not a mystery. */
	function uploadNote(result: UploadOutcome): string | undefined {
		const deduplicated = (result.file as { deduplicated?: boolean } | undefined)?.deduplicated;
		return deduplicated ? m.admin_files_dedup() : undefined;
	}

	/**
	 * One-shot flash (round-2 review): `?deleted=1` is consumed from the URL
	 * via replaceState, so a refresh / back-nav cannot replay a stale banner;
	 * the delete dialog also closes on success. Same-route redirects keep
	 * this component mounted, so the param is WATCHED rather than read once.
	 */
	let flashDeleted = $state(false);
	$effect(() => {
		if (page.url.searchParams.get('deleted') === '1') {
			flashDeleted = true;
			deleteTarget = null;
			const url = new URL(page.url);
			url.searchParams.delete('deleted');
			replaceState(url, {});
		}
	});

	const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
		pending: 'outline',
		attached: 'default',
		detached: 'secondary'
	};
	const ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.tif,.tiff,.pdf,.zip,.txt,.md';

	/**
	 * Public content URL: webp `@full` for transcoded photos, the ORIGINAL key for
	 * GIFs (pass-through: the original is the public tier) and for attachments
	 * (public once registered; /i enforces the registry check).
	 */
	function publicUrl(row: FileRow): string {
		if (row.mimeType === 'image/gif') return `/i/${row.objectKey}`;
		return `/i/${row.mimeType.startsWith('image/') ? variantKeyFor(row.objectKey, 'full') : row.objectKey}`;
	}

	async function copyUrl(row: FileRow): Promise<void> {
		try {
			await navigator.clipboard.writeText(new URL(publicUrl(row), location.origin).toString());
			copiedId = row.id;
			setTimeout(() => {
				if (copiedId === row.id) copiedId = null;
			}, 1500);
		} catch {
			// Clipboard unavailable (permissions) — the preview link still works.
		}
	}
</script>

<svelte:head>
	<title>{m.admin_nav_files()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if flashDeleted}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			{m.admin_files_flash_deleted()}
		</div>
	{/if}
	{#if actionData.message}
		<div
			class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{actionData.message}
		</div>
	{/if}
	{#if actionData.galleryAdded}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			{actionData.galleryAdded.kind === 'ok'
				? m.admin_files_gallery_added({ slug: actionData.galleryAdded.slug ?? '' })
				: m.admin_files_gallery_exists()}
		</div>
	{/if}
	<MediaUploadDialog
		bind:open={uploadOpen}
		action="?/upload"
		accept={ACCEPT}
		maxBatch={data.limits.maxBatch}
		maxBytes={data.limits.maxBytes}
		description={m.admin_files_upload_hint({
			batch: data.limits.maxBatch,
			size: data.limits.maxBytes / 1024 / 1024
		})}
		resultNote={uploadNote}
	/>

	{#if data.listTruncated}
		<p role="status" class="text-xs text-muted-foreground">
			{m.admin_files_cap_notice({ count: data.files.length })}
		</p>
	{/if}

	<ListTable
		{columns}
		rows={data.files}
		rowKey={(file) => file.id}
		label={m.admin_nav_files()}
		class="min-h-96"
	>
		{#snippet header(col)}
			{#if col.id === 'preview'}
				<ListFilter
					path={LIST_PATH}
					label={m.admin_common_type()}
					current={currentKind}
					selected={data.filters.kind}
					options={kindOptions}
				/>
			{:else if col.id === 'file'}
				<ListSearch
					path={LIST_PATH}
					label={m.admin_files_keyword()}
					placeholder={m.admin_files_filename_ph()}
					value={data.filters.keyword}
					hidden={searchHidden}
					clearSearch={querySearch({ keyword: undefined })}
				/>
			{:else if col.id === 'status'}
				<ListFilter
					path={LIST_PATH}
					label={col.label}
					current={currentStatus}
					selected={data.filters.status}
					options={statusOptions}
				/>
			{:else if col.id === 'refs'}
				<ListFilter
					path={LIST_PATH}
					label={col.label}
					current={currentOrphan}
					selected={data.filters.orphan ? '1' : ''}
					options={orphanOptions}
				/>
			{:else if col.id === 'uploaded'}
				<ListFilter
					path={LIST_PATH}
					label={col.label}
					current={currentSince}
					selected={data.filters.since}
					options={sinceOptions}
				/>
			{:else if col.id === 'actions'}
				<RefreshButton onclick={() => invalidateAll()} />
			{/if}
		{/snippet}

		{#snippet row(file)}
			<Table.Cell class={cn(listColumnClass(cols.preview), 'py-1.5')}>
				{#if file.mimeType.startsWith('image/')}
					<img
						src={file.mimeType === 'image/gif'
							? `/i/${file.objectKey}`
							: `/i/${variantKeyFor(file.objectKey, 'thumb')}`}
						alt={file.fileName}
						loading="lazy"
						class="size-10 rounded-md border object-cover"
					/>
				{:else}
					<div
						class="flex size-10 items-center justify-center rounded-md border bg-muted text-muted-foreground"
					>
						<IconFile class="size-4" />
					</div>
				{/if}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.file), 'max-w-0')}>
				<p class="truncate font-medium">{file.fileName}</p>
				<p class="truncate text-xs text-muted-foreground">{file.mimeType}</p>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.dimensions), 'text-xs text-muted-foreground')}>
				{file.width && file.height ? `${file.width}×${file.height}` : '—'}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.size), 'text-xs text-muted-foreground')}>
				{formatBytes(file.byteSize)}
			</Table.Cell>
			<Table.Cell class={listColumnClass(cols.status)}>
				<Badge variant={STATUS_VARIANTS[file.status] ?? 'outline'} class="text-xs">
					{STATUS_LABELS[file.status] ?? file.status}
				</Badge>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.refs), 'text-xs text-muted-foreground')}>
				{file.refCount}
				{#if file.isInGallery}<IconPhoto class="ml-1 inline size-3.5" />{/if}
			</Table.Cell>
			<Table.Cell
				class={cn(
					listColumnClass(cols.uploaded),
					'text-xs whitespace-nowrap text-muted-foreground'
				)}
			>
				{formatDateTime(new Date(file.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
				<ListRowActions
					deleteLabel={m.admin_common_delete()}
					onDelete={() => (deleteTarget = { id: file.id, name: file.fileName })}
				>
					{#snippet primary()}
						<Button
							variant="ghost"
							size="icon-sm"
							href="/i/{file.objectKey}"
							download={file.fileName}
							aria-label={m.admin_files_download()}
							title={m.admin_files_download()}
						>
							<IconDownload />
						</Button>
					{/snippet}
					{#snippet more()}
						<DropdownMenu.Item onclick={() => window.open(publicUrl(file), '_blank', 'noopener')}>
							<IconExternalLink data-icon="inline-start" />
							{m.admin_files_col_preview()}
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => copyUrl(file)}>
							{#if copiedId === file.id}
								<IconCheck data-icon="inline-start" />
							{:else}
								<IconCopy data-icon="inline-start" />
							{/if}
							{copiedId === file.id ? m.admin_settings_account_copied() : m.admin_files_copy_url()}
						</DropdownMenu.Item>
						{#if file.mimeType.startsWith('image/') && !file.isInGallery}
							<DropdownMenu.Item onclick={() => addGallery(file.id)}>
								<IconPhoto data-icon="inline-start" />
								{m.admin_files_add_to_gallery()}
							</DropdownMenu.Item>
						{/if}
					{/snippet}
				</ListRowActions>
			</Table.Cell>
		{/snippet}

		{#snippet empty()}
			<Empty class="mx-auto py-14">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">{m.admin_files_empty()}</h3>
					<p class="text-sm text-muted-foreground">{m.admin_files_empty_desc()}</p>
				</div>
			</Empty>
		{/snippet}
	</ListTable>

	<!-- "Add to gallery" is a form action; the menu item submits this one. -->
	<form method="POST" action="?/addToGallery" use:enhance bind:this={galleryForm} class="hidden">
		<input type="hidden" name="id" value={galleryId} />
	</form>

	<section class="mx-4 rounded-xl border bg-background p-4 sm:mx-6 lg:mx-8">
		<h2 class="mb-1 text-sm font-medium">{m.admin_files_audit_title()}</h2>
		<p class="mb-3 text-xs text-muted-foreground">
			{m.admin_files_audit_desc_before()}<code>pnpm media:purge</code
			>{m.admin_files_audit_desc_after()}
		</p>
		<div class="flex flex-wrap gap-3">
			<form method="POST" action="?/audit">
				<Button type="submit" variant="secondary" size="sm">
					<IconRefresh data-icon="inline-start" />
					{m.admin_files_audit_run()}
				</Button>
			</form>
			<form method="POST" action="?/purgePreview">
				<Button type="submit" variant="outline" size="sm">{m.admin_files_purge_preview()}</Button>
			</form>
		</div>

		{#if actionData.audit}
			<div class="mt-4 space-y-2 text-sm">
				<p class="text-xs text-muted-foreground">
					{m.admin_files_audit_generated({ time: actionData.audit.generatedAt })}
				</p>
				<p>
					{m.admin_files_audit_counts({
						orphans: actionData.audit.orphans.length,
						broken: actionData.audit.brokenLinks.length,
						missing: actionData.audit.missingObjects.length
					})}
				</p>
				{#if actionData.audit.truncated}
					<p class="text-xs text-amber-600 dark:text-amber-400">
						{m.admin_files_audit_truncated()}
					</p>
				{/if}
				{#each actionData.audit.orphans as orphan (orphan.objectKey)}
					<p class="text-xs text-muted-foreground">
						{m.admin_files_orphan_row({
							key: orphan.objectKey,
							name: orphan.fileName,
							days: orphan.ageDays
						})}
					</p>
				{/each}
				{#each actionData.audit.brokenLinks as link (link.key + link.refId)}
					<p class="text-xs text-muted-foreground">② {link.key} ← {link.refType}:{link.refId}</p>
				{/each}
				{#each actionData.audit.missingObjects as row (row.objectKey)}
					<p class="text-xs text-muted-foreground">
						{m.admin_files_missing_row({ key: row.objectKey, name: row.fileName })}
					</p>
				{/each}
			</div>
		{/if}

		{#if actionData.purge}
			<div class="mt-4 space-y-2 text-sm">
				<p>{m.admin_files_purge_summary({ count: actionData.purge.length })}</p>
				{#each actionData.purge as candidate (candidate.objectKey)}
					<p class="text-xs text-muted-foreground">
						{m.admin_files_purge_row({
							key: candidate.objectKey,
							name: candidate.fileName,
							status: candidate.status,
							days: candidate.ageDays
						})}
					</p>
				{/each}
			</div>
		{/if}
	</section>
</div>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => !open && (deleteTarget = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_files_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_files_delete_desc({ name: deleteTarget?.name ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form method="POST" action="?/delete">
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Action type="submit" variant="destructive"
					>{m.admin_common_delete()}</AlertDialog.Action
				>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

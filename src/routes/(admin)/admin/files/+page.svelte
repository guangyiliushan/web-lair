<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { applyUploadResults, mapUploadError, uploadEachFile } from '$lib/utils/upload-each';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { formatDateTime } from '$lib/utils/i18n';
	import { variantKeyFor } from '$lib/media/keys';
	import { formatBytes } from '$lib/utils/format';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconFile from '@tabler/icons-svelte-runes/icons/file';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';

	let { data, form }: PageProps = $props();

	type FileRow = (typeof data.files)[number];
	type UploadResult = {
		fileName: string;
		ok: boolean;
		file?: { id: string; fileName: string; deduplicated: boolean };
		code?: string;
		message?: string;
	};
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
			uploadResults?: UploadResult[];
			galleryAdded?: { kind: string; slug: string | null };
			audit?: AuditReport;
			purge?: PurgeList;
		}
	);

	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let copiedId = $state<string | null>(null);

	let uploading = $state(false);

	/** Q4 (deploy note): one request per file keeps every body under BODY_SIZE_LIMIT. */
	async function uploadAll(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const input = form.querySelector<HTMLInputElement>('input[name="files"]');
		const files = Array.from(input?.files ?? []);
		if (files.length === 0) {
			await applyUploadResults({ results: [], message: m.admin_files_err_no_files() });
			return;
		}
		if (uploading) return;
		if (files.length > data.limits.maxBatch) {
			await applyUploadResults({
				results: [],
				message: m.admin_media_err_too_many({ count: data.limits.maxBatch })
			});
			return;
		}
		uploading = true;
		try {
			const outcome = await uploadEachFile({
				action: '?/upload',
				files,
				maxBytes: data.limits.maxBytes,
				fallbackMessage: m.admin_media_err_upload_failed(),
				tooLargeMessage: (name) => m.admin_media_err_too_big({ name }),
				mapError: (status, name) =>
					mapUploadError(status, name, {
						tooBig: (n) => m.admin_media_err_too_big({ name: n }),
						rate: m.admin_media_err_rate,
						session: m.admin_media_err_session
					})
			});
			if (outcome.redirected) {
				if (outcome.message) {
					await applyUploadResults({ results: outcome.results, message: outcome.message });
				}
				return;
			}
			await applyUploadResults(outcome);
		} finally {
			uploading = false;
			if (input) input.value = '';
		}
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

	const STATUS_LABELS: Record<string, string> = {
		pending: m.admin_files_status_pending(),
		attached: m.admin_files_status_attached(),
		detached: m.admin_files_status_detached()
	};
	const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
		pending: 'outline',
		attached: 'default',
		detached: 'secondary'
	};
	const ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.tif,.tiff,.pdf,.zip,.txt,.md';

	/**
	 * Public content URL: webp `@full` for transcoded photos, the ORIGINAL
	 * key for GIFs (plan §4.3 pass-through — the original is the public tier) and for
	 * attachments (public once registered; /i enforces the registry check).
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
	{#if actionData.uploadResults}
		<div class="rounded-md border bg-background px-3 py-2 text-sm" role="status">
			{#each actionData.uploadResults as result, index (result.fileName + ':' + index)}
				<p class:opacity-60={!result.ok}>
					{result.ok ? '✓' : '✗'}
					{result.fileName}
					{#if result.ok && result.file?.deduplicated}{m.admin_files_dedup()}{/if}
					{#if !result.ok}— {result.message ?? result.code}{/if}
				</p>
			{/each}
		</div>
	{/if}

	<section class="rounded-xl border bg-background p-4">
		<h2 class="mb-3 text-sm font-medium">
			{m.admin_files_upload_hint({
				batch: data.limits.maxBatch,
				size: data.limits.maxBytes / 1024 / 1024
			})}
		</h2>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			class="flex flex-wrap items-center gap-3"
			onsubmit={uploadAll}
		>
			<input
				type="file"
				name="files"
				aria-label={m.admin_media_pick_files()}
				multiple
				accept={ACCEPT}
				class="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
			/>
			<Button type="submit" size="sm" disabled={uploading}>
				<IconUpload data-icon="inline-start" />
				{m.admin_media_upload()}
			</Button>
		</form>
	</section>

	<section class="flex flex-col gap-4">
		<form method="GET" class="flex flex-wrap items-end gap-3">
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_common_type()}
				<select
					name="kind"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.kind === ''}>{m.admin_media_filter_all()}</option>
					<option value="image" selected={data.filters.kind === 'image'}
						>{m.admin_files_kind_image()}</option
					>
					<option value="file" selected={data.filters.kind === 'file'}
						>{m.admin_files_kind_file()}</option
					>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_common_status()}
				<select
					name="status"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.status === ''}
						>{m.admin_media_filter_all()}</option
					>
					<option value="pending" selected={data.filters.status === 'pending'}
						>{m.admin_files_status_pending()}</option
					>
					<option value="attached" selected={data.filters.status === 'attached'}
						>{m.admin_files_status_attached()}</option
					>
					<option value="detached" selected={data.filters.status === 'detached'}
						>{m.admin_files_status_detached()}</option
					>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_files_keyword()}
				<input
					name="keyword"
					value={data.filters.keyword}
					placeholder={m.admin_files_filename_ph()}
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				/>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_media_time()}
				<select
					name="since"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.since === ''}>{m.admin_media_filter_all()}</option
					>
					<option value="7d" selected={data.filters.since === '7d'}
						>{m.admin_media_last_7d()}</option
					>
					<option value="30d" selected={data.filters.since === '30d'}
						>{m.admin_media_last_30d()}</option
					>
					<option value="90d" selected={data.filters.since === '90d'}
						>{m.admin_media_last_90d()}</option
					>
				</select>
			</label>
			<label class="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
				<input
					type="checkbox"
					name="orphan"
					value="1"
					checked={data.filters.orphan}
					class="size-4 rounded border"
				/>
				{m.admin_files_orphan_only()}
			</label>
			<Button type="submit" variant="secondary" size="sm">{m.admin_media_filter()}</Button>
		</form>

		{#if data.listTruncated}
			<p class="text-xs text-muted-foreground">
				{m.admin_files_cap_notice({ count: data.files.length })}
			</p>
		{/if}

		{#if data.files.length === 0}
			<Empty class="py-12">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">{m.admin_files_empty()}</h3>
					<p class="text-sm text-muted-foreground">
						{m.admin_files_empty_desc()}
					</p>
				</div>
			</Empty>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-14">{m.admin_files_col_preview()}</Table.Head>
							<Table.Head>{m.admin_files_kind_file()}</Table.Head>
							<Table.Head class="hidden w-28 md:table-cell"
								>{m.admin_files_col_dimensions()}</Table.Head
							>
							<Table.Head class="w-24">{m.admin_files_col_size()}</Table.Head>
							<Table.Head class="w-24">{m.admin_common_status()}</Table.Head>
							<Table.Head class="hidden w-24 sm:table-cell">{m.admin_files_col_refs()}</Table.Head>
							<Table.Head class="hidden w-40 lg:table-cell"
								>{m.admin_files_col_uploaded()}</Table.Head
							>
							<Table.Head class="w-44 text-right">{m.admin_common_actions()}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.files as row (row.id)}
							<Table.Row>
								<Table.Cell>
									{#if row.mimeType.startsWith('image/')}
										<img
											src={row.mimeType === 'image/gif'
												? `/i/${row.objectKey}`
												: `/i/${variantKeyFor(row.objectKey, 'thumb')}`}
											alt={row.fileName}
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
								<Table.Cell class="max-w-0">
									<p class="truncate font-medium">{row.fileName}</p>
									<p class="truncate text-xs text-muted-foreground">{row.mimeType}</p>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{row.width && row.height ? `${row.width}×${row.height}` : '—'}
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground"
									>{formatBytes(row.byteSize)}</Table.Cell
								>
								<Table.Cell>
									<Badge variant={STATUS_VARIANTS[row.status] ?? 'outline'} class="text-xs">
										{STATUS_LABELS[row.status] ?? row.status}
									</Badge>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
									{row.refCount}
									{#if row.isInGallery}<IconPhoto class="ml-1 inline size-3.5" />{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
									{formatDateTime(new Date(row.createdAt), {
										dateStyle: 'short',
										timeStyle: 'short'
									})}
								</Table.Cell>
								<Table.Cell class="text-right">
									<div class="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											href={publicUrl(row)}
											target="_blank"
											aria-label={m.admin_files_col_preview()}
										>
											<IconExternalLink class="size-4" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											onclick={() => copyUrl(row)}
											aria-label={m.admin_files_copy_url()}
										>
											<IconCopy class="size-4" />
										</Button>
										{#if copiedId === row.id}
											<span class="text-xs text-emerald-600 dark:text-emerald-400"
												>{m.admin_settings_account_copied()}</span
											>
										{/if}
										{#if row.mimeType.startsWith('image/') && !row.isInGallery}
											<form method="POST" action="?/addToGallery">
												<input type="hidden" name="id" value={row.id} />
												<Button
													type="submit"
													variant="ghost"
													size="icon"
													class="size-8"
													aria-label={m.admin_files_add_to_gallery()}
												>
													<IconPhoto class="size-4" />
												</Button>
											</form>
										{/if}
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											href="/i/{row.objectKey}"
											download={row.fileName}
											aria-label={m.admin_files_download()}
										>
											<IconDownload class="size-4" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="size-8 text-destructive"
											onclick={() => (deleteTarget = { id: row.id, name: row.fileName })}
											aria-label={m.admin_common_delete()}
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
	</section>

	<section class="rounded-xl border bg-background p-4">
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

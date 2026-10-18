<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '$lib/components/ui/empty';
	import { formatDateTime } from '$lib/utils/i18n';
	import { formatBytes } from '$lib/utils/format';
	import { photoTileSrc } from '$lib/components/photos/photo-tile';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { applyUploadResults, mapUploadError, uploadEachFile } from '$lib/utils/upload-each';
	import { locales } from '$lib/paraglide/runtime';
	import { localeLabels } from '$lib/stores/locale.svelte';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconEyeOff from '@tabler/icons-svelte-runes/icons/eye-off';
	import IconMapPin from '@tabler/icons-svelte-runes/icons/map-pin';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';

	let { data, form }: PageProps = $props();

	type PhotoRow = (typeof data.photos)[number];

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
	type UploadResult = {
		fileName: string;
		ok: boolean;
		file?: { id: string; fileName: string };
		message?: string;
		code?: string;
		added?: boolean;
		galleryError?: string | null;
	};

	const actionData = $derived(
		(form ?? {}) as {
			message?: string;
			uploadResults?: UploadResult[];
			bulkResult?: { op: string; done: number; failed: number };
			deleted?: {
				removeFile: boolean;
				fileDeleted: boolean;
				fileBlocked: boolean;
				fileDeleteFailed: boolean;
			};
			saved?: boolean;
		}
	);

	const BULK_LABELS: Record<string, string> = {
		show: m.admin_photos_bulk_show(),
		hide: m.admin_photos_bulk_hide(),
		tag: m.admin_photos_bulk_tag(),
		delete: m.admin_common_delete()
	};

	let selectedIds = $state<string[]>([]);
	let editingId = $state<string | null>(null);
	let deleteTarget = $state<PhotoRow | null>(null);
	let bulkDeleteOpen = $state(false);

	const editing = $derived(
		editingId ? (data.photos.find((row) => row.id === editingId) ?? null) : null
	);

	// Close the delete dialog once the action lands (round-2 review: it used
	// to stay open above the success flash).
	$effect(() => {
		if (actionData.deleted) deleteTarget = null;
	});

	const ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.tif,.tiff';
	const LOCALE_LABELS = locales.map((key) => ({ key, label: localeLabels[key] }));

	function rowTitle(row: PhotoRow): string {
		const title = row.title ?? {};
		return title['zh-cn'] ?? title.en ?? title.ja ?? row.slug;
	}

	// Shared tier rule (round-3 review: the local copies had drifted from
	// photoTileSrc, the single source for GIF-is-its-own-tier).
	function thumbUrl(row: PhotoRow): string {
		return photoTileSrc(row, 'thumb');
	}

	function fullUrl(row: PhotoRow): string {
		return photoTileSrc(row, 'full');
	}
</script>

<svelte:head><title>{m.admin_nav_photos()} - Lair Admin</title></svelte:head>

<div class="flex flex-col gap-6">
	{#if actionData.saved}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			{m.admin_photos_saved()}
		</div>
	{/if}
	{#if actionData.deleted}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			{m.admin_photos_removed()}{actionData.deleted.removeFile
				? actionData.deleted.fileDeleted
					? m.admin_photos_removed_deleted()
					: actionData.deleted.fileBlocked
						? m.admin_photos_removed_file_blocked()
						: actionData.deleted.fileDeleteFailed
							? m.admin_photos_removed_failed()
							: m.admin_photos_removed_not_deleted()
				: ''}{m.admin_photos_period()}
		</div>
	{/if}
	{#if actionData.bulkResult}
		<div role="status" class="rounded-md border bg-background px-3 py-2 text-sm">
			{m.admin_photos_bulk_summary({
				op: BULK_LABELS[actionData.bulkResult.op] ?? actionData.bulkResult.op,
				done: actionData.bulkResult.done,
				failed: actionData.bulkResult.failed
			})}
		</div>
	{/if}
	{#if actionData.message}
		<div
			class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{actionData.message}
		</div>
	{/if}
	{#if actionData.uploadResults}
		<div class="rounded-md border bg-background px-3 py-2 text-sm">
			{#each actionData.uploadResults as result, index (result.fileName + ':' + index)}
				<p class:opacity-60={!result.ok}>
					{result.ok ? '✓' : '✗'}
					{result.fileName}
					{#if result.ok && result.added}{m.admin_photos_added()}{/if}
					{#if result.ok && result.galleryError}{m.admin_photos_gallery_error({
							error: result.galleryError
						})}{/if}
					{#if !result.ok}— {result.message ?? result.code}{/if}
				</p>
			{/each}
		</div>
	{/if}

	<section class="rounded-xl border bg-background p-4">
		<h2 class="mb-1 text-sm font-medium">
			{m.admin_photos_upload_hint({
				batch: data.limits.maxBatch,
				size: data.limits.maxBytes / 1024 / 1024
			})}
		</h2>
		<p class="mb-3 text-xs text-muted-foreground">
			{m.admin_photos_upload_cli_hint()}<code>pnpm media:import &lt;dir&gt;</code>
		</p>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			class="flex flex-wrap items-center gap-3"
			onsubmit={uploadAll}
		>
			<input
				aria-label={m.admin_photos_pick_files()}
				type="file"
				name="files"
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
				{m.admin_photos_visibility()}
				<select
					name="visibility"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="all" selected={data.filters.visibility === 'all'}
						>{m.admin_media_filter_all()}</option
					>
					<option value="visible" selected={data.filters.visibility === 'visible'}
						>{m.admin_photos_visible()}</option
					>
					<option value="hidden" selected={data.filters.visibility === 'hidden'}
						>{m.admin_photos_hidden()}</option
					>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_photos_tag()}
				<select name="tag" class="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
					<option value="" selected={data.filters.tag === ''}>{m.admin_media_filter_all()}</option>
					{#each data.tagOptions as option (option.id)}
						<option value={option.id} selected={data.filters.tag === option.id}
							>{option.name}</option
						>
					{/each}
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_photos_slug_keyword()}
				<input
					name="keyword"
					value={data.filters.keyword}
					placeholder={m.admin_photos_slug_placeholder()}
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
					name="location"
					value="1"
					checked={data.filters.location}
					class="size-4 rounded border"
				/>
				{m.admin_photos_has_geo()}
			</label>
			<Button type="submit" variant="secondary" size="sm">{m.admin_media_filter()}</Button>
		</form>

		{#if data.listTruncated}
			<p class="text-xs text-muted-foreground">
				{m.admin_photos_cap_notice({ count: data.photos.length })}
			</p>
		{/if}

		{#if data.photos.length === 0}
			<Empty class="py-12">
				<EmptyHeader>
					<EmptyTitle>{m.admin_photos_empty()}</EmptyTitle>
					<EmptyDescription>{m.admin_photos_empty_desc()}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		{:else}
			<form method="POST" action="?/bulk" class="flex flex-col gap-3">
				<div
					class="flex flex-wrap items-center gap-3 rounded-xl border bg-background px-3 py-2 text-sm"
				>
					<span class="text-muted-foreground"
						>{m.admin_photos_selected_count({ count: selectedIds.length })}</span
					>
					<select
						name="op"
						aria-label={m.admin_photos_bulk_actions()}
						class="h-8 rounded-md border bg-background px-2 text-sm"
					>
						<option value="show">{m.admin_photos_bulk_show()}</option>
						<option value="hide">{m.admin_photos_bulk_hide()}</option>
						<option value="tag">{m.admin_photos_bulk_tag()}</option>
					</select>
					<input
						name="tags"
						aria-label={m.admin_photos_tag_input()}
						placeholder={m.admin_photos_tag_input()}
						class="h-8 rounded-md border bg-background px-2 text-sm"
					/>
					<Button type="submit" variant="secondary" size="sm" disabled={selectedIds.length === 0}>
						{m.admin_photos_bulk_run()}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="text-destructive"
						disabled={selectedIds.length === 0}
						onclick={() => (bulkDeleteOpen = true)}
					>
						{m.admin_photos_bulk_delete_selected()}
					</Button>
				</div>

				<ul class="grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{#each data.photos as row (row.id)}
						<li class="group relative overflow-hidden rounded-xl border bg-background">
							<label
								class="absolute top-2 left-2 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md border bg-background/80 backdrop-blur"
							>
								<input
									type="checkbox"
									name="ids"
									value={row.id}
									bind:group={selectedIds}
									aria-label={m.admin_photos_select_row({ title: rowTitle(row) })}
									class="size-4 rounded border"
								/>
							</label>
							{#if !row.isVisible}
								<Badge variant="secondary" class="absolute top-2 right-2 z-10 text-xs">
									<IconEyeOff class="mr-1 size-3" />
									{m.admin_photos_hidden()}
								</Badge>
							{/if}
							<button
								type="button"
								class="block w-full"
								onclick={() => (editingId = row.id)}
								aria-label={m.admin_photos_edit_row({ slug: row.slug })}
							>
								<img
									src={thumbUrl(row)}
									alt={row.fileName}
									loading="lazy"
									class="aspect-[4/3] w-full object-cover"
								/>
							</button>
							<div class="flex flex-col gap-1 p-3">
								<p class="truncate text-sm font-medium">{rowTitle(row)}</p>
								<p class="truncate text-xs text-muted-foreground">/{row.slug}</p>
								<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									{#if row.takenAt}
										{formatDateTime(new Date(row.takenAt), { dateStyle: 'medium' })}
									{/if}
									{#if row.latitude && row.longitude}
										<IconMapPin class="size-3.5" />
									{/if}
									{#if row.tags.length > 0}
										<span class="inline-flex items-center gap-1">
											<IconTag class="size-3.5" />{row.tags.length}
										</span>
									{/if}
									{#if row.refCount > 0}
										<span title={m.admin_photos_ref_count_title()}
											>{m.admin_photos_ref_count({ count: row.refCount })}</span
										>
									{/if}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			</form>
		{/if}
	</section>

	{#if editing}
		<aside class="rounded-xl border bg-background p-4">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-sm font-medium">{m.admin_photos_edit_panel()}</h2>
				<Button variant="ghost" size="sm" onclick={() => (editingId = null)}
					>{m.admin_common_close()}</Button
				>
			</div>
			<div class="grid gap-4 lg:grid-cols-[280px_1fr]">
				<div class="flex flex-col gap-2">
					<img
						src={fullUrl(editing)}
						alt={editing.fileName}
						class="w-full rounded-md border object-contain"
					/>
					<p class="text-xs text-muted-foreground">
						{editing.width && editing.height
							? `${editing.width}×${editing.height} · `
							: ''}{formatBytes(editing.byteSize)} · {editing.fileName}
					</p>
					<p class="text-xs text-muted-foreground">
						{m.admin_photos_ref_places({ count: editing.refCount })}{#if editing.tags.length}
							{m.admin_photos_tags_line()}{editing.tags
								.map((tag) => tag.name)
								.join(m.admin_photos_tags_join())}{/if}
					</p>
					<a
						class="inline-flex items-center gap-1 text-xs underline"
						href={`/photos/${editing.slug}`}
						target="_blank"
						rel="noreferrer"
					>
						<IconExternalLink class="size-3.5" />{m.admin_photos_view_public()}
					</a>
				</div>
				<form method="POST" action="?/update" class="flex flex-col gap-3">
					<input type="hidden" name="id" value={editing.id} />
					<div class="grid gap-3 md:grid-cols-3">
						{#each LOCALE_LABELS as locale (locale.key)}
							<label class="grid gap-1 text-xs text-muted-foreground">
								{m.admin_photos_title_locale({ locale: locale.label })}
								<input
									name={`title_${locale.key}`}
									value={editing.title?.[locale.key] ?? ''}
									class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
								/>
							</label>
						{/each}
					</div>
					<div class="grid gap-3 md:grid-cols-3">
						{#each LOCALE_LABELS as locale (locale.key)}
							<label class="grid gap-1 text-xs text-muted-foreground">
								{m.admin_photos_desc_locale({ locale: locale.label })}
								<input
									name={`description_${locale.key}`}
									value={editing.description?.[locale.key] ?? ''}
									class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
								/>
							</label>
						{/each}
					</div>
					<div class="grid gap-3 sm:grid-cols-3">
						<label class="grid gap-1 text-xs text-muted-foreground">
							Slug
							<input
								name="slug"
								value={editing.slug}
								class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
							/>
						</label>
						<label class="grid gap-1 text-xs text-muted-foreground">
							{m.admin_photos_taken_at()}
							<input
								type="datetime-local"
								name="takenAt"
								value={editing.takenAtLocal}
								class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
							/>
						</label>
						<label class="flex items-center gap-2 self-end pb-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								name="isVisible"
								value="1"
								checked={editing.isVisible}
								class="size-4 rounded border"
							/>
							{m.admin_photos_public_visible()}
						</label>
					</div>
					<label class="grid gap-1 text-xs text-muted-foreground">
						{m.admin_photos_edit_tags()}
						<input
							name="tags"
							value={editing.tags.map((tag) => tag.name).join(', ')}
							class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
						/>
					</label>
					<div class="flex items-center gap-2">
						<Button type="submit" size="sm">{m.admin_common_save()}</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="text-destructive"
							onclick={() => (deleteTarget = editing)}
						>
							<IconTrash data-icon="inline-start" />
							{m.admin_photos_remove()}
						</Button>
					</div>
				</form>
			</div>
		</aside>
	{/if}
</div>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => !open && (deleteTarget = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_photos_remove_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.slug}”
				{m.admin_photos_remove_desc()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/delete">
			<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
			<label class="flex items-center gap-2 py-2 text-sm">
				<input type="checkbox" name="removeFile" value="1" class="size-4 rounded border" />
				{m.admin_photos_remove_also_file()}
			</label>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
				<AlertDialog.Action type="submit" variant="destructive"
					>{m.admin_photos_remove_action()}</AlertDialog.Action
				>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={bulkDeleteOpen} onOpenChange={(open) => (bulkDeleteOpen = open)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title
				>{m.admin_photos_bulk_delete_title({ count: selectedIds.length })}</AlertDialog.Title
			>
			<AlertDialog.Description>
				{m.admin_photos_bulk_delete_desc()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/bulk">
			{#each selectedIds as id (id)}
				<input type="hidden" name="ids" value={id} />
			{/each}
			<input type="hidden" name="op" value="delete" />
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
				<AlertDialog.Action type="submit" variant="destructive"
					>{m.admin_common_delete()}</AlertDialog.Action
				>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>

<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '$lib/components/ui/empty';
	import { formatDateTime } from '$lib/utils/i18n';
	import { formatBytes } from '$lib/utils/format';
	import { photoTileSrc } from '$lib/components/photos/photo-tile';
	import type { PageProps } from './$types';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconEyeOff from '@tabler/icons-svelte-runes/icons/eye-off';
	import IconMapPin from '@tabler/icons-svelte-runes/icons/map-pin';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';

	let { data, form }: PageProps = $props();

	type PhotoRow = (typeof data.photos)[number];
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
		show: '设为可见',
		hide: '设为隐藏',
		tag: '加标签',
		delete: '删除'
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
	const LOCALE_LABELS: Array<{ key: 'en' | 'zh-cn' | 'ja'; label: string }> = [
		{ key: 'en', label: 'EN' },
		{ key: 'zh-cn', label: '中文' },
		{ key: 'ja', label: '日本語' }
	];

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

<svelte:head><title>图床 - Lair Admin</title></svelte:head>

<div class="flex flex-col gap-6">
	{#if actionData.saved}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			已保存。
		</div>
	{/if}
	{#if actionData.deleted}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			已移出图床{actionData.deleted.removeFile
				? actionData.deleted.fileDeleted
					? '并删除文件'
					: actionData.deleted.fileBlocked
						? '（文件仍被引用，未删除）'
						: actionData.deleted.fileDeleteFailed
							? '（照片已移除；文件删除失败，可稍后重试）'
							: '（文件未删除）'
				: ''}。
		</div>
	{/if}
	{#if actionData.bulkResult}
		<div class="rounded-md border bg-background px-3 py-2 text-sm">
			批量「{BULK_LABELS[actionData.bulkResult.op] ?? actionData.bulkResult.op}」：成功
			{actionData.bulkResult.done} · 失败 {actionData.bulkResult.failed}
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
					{#if result.ok && result.added}→ 已入图床{/if}
					{#if result.ok && result.galleryError}（{result.galleryError}）{/if}
					{#if !result.ok}— {result.message ?? result.code}{/if}
				</p>
			{/each}
		</div>
	{/if}

	<section class="rounded-xl border bg-background p-4">
		<h2 class="mb-1 text-sm font-medium">
			上传到图床（≤ {data.limits.maxBatch} 个/批，单文件 ≤ {data.limits.maxBytes / 1024 / 1024}MB）
		</h2>
		<p class="mb-3 text-xs text-muted-foreground">
			图片会上传并加入图床；目录批量导入请用 CLI：<code>pnpm media:import &lt;dir&gt;</code>
		</p>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			class="flex flex-wrap items-center gap-3"
		>
			<input
				aria-label="选择要上传的图片"
				type="file"
				name="files"
				multiple
				accept={ACCEPT}
				class="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
			/>
			<Button type="submit" size="sm">
				<IconUpload data-icon="inline-start" />
				上传
			</Button>
		</form>
	</section>

	<section class="flex flex-col gap-4">
		<form method="GET" class="flex flex-wrap items-end gap-3">
			<label class="grid gap-1 text-xs text-muted-foreground">
				可见性
				<select
					name="visibility"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="all" selected={data.filters.visibility === 'all'}>全部</option>
					<option value="visible" selected={data.filters.visibility === 'visible'}>可见</option>
					<option value="hidden" selected={data.filters.visibility === 'hidden'}>隐藏</option>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				标签
				<select name="tag" class="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
					<option value="" selected={data.filters.tag === ''}>全部</option>
					{#each data.tagOptions as option (option.id)}
						<option value={option.id} selected={data.filters.tag === option.id}
							>{option.name}</option
						>
					{/each}
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				Slug 关键词
				<input
					name="keyword"
					value={data.filters.keyword}
					placeholder="按 slug 搜索"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				/>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				时间
				<select
					name="since"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.since === ''}>全部</option>
					<option value="7d" selected={data.filters.since === '7d'}>近 7 天</option>
					<option value="30d" selected={data.filters.since === '30d'}>近 30 天</option>
					<option value="90d" selected={data.filters.since === '90d'}>近 90 天</option>
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
				有位置
			</label>
			<Button type="submit" variant="secondary" size="sm">筛选</Button>
		</form>

		{#if data.listTruncated}
			<p class="text-xs text-muted-foreground">
				仅显示前 {data.photos.length} 张（达到上限，请用筛选缩小范围）。
			</p>
		{/if}

		{#if data.photos.length === 0}
			<Empty class="py-12">
				<EmptyHeader>
					<EmptyTitle>暂无照片</EmptyTitle>
					<EmptyDescription>上传图片或从内容资产「加入图床」，照片会出现在这里。</EmptyDescription>
				</EmptyHeader>
			</Empty>
		{:else}
			<form method="POST" action="?/bulk" class="flex flex-col gap-3">
				<div
					class="flex flex-wrap items-center gap-3 rounded-xl border bg-background px-3 py-2 text-sm"
				>
					<span class="text-muted-foreground">已选 {selectedIds.length} 张</span>
					<select
						name="op"
						aria-label="批量操作"
						class="h-8 rounded-md border bg-background px-2 text-sm"
					>
						<option value="show">设为可见</option>
						<option value="hide">设为隐藏</option>
						<option value="tag">加标签</option>
					</select>
					<input
						name="tags"
						aria-label="标签（逗号分隔，仅「加标签」用）"
						placeholder="标签（逗号分隔，仅「加标签」用）"
						class="h-8 rounded-md border bg-background px-2 text-sm"
					/>
					<Button type="submit" variant="secondary" size="sm" disabled={selectedIds.length === 0}>
						执行
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="text-destructive"
						disabled={selectedIds.length === 0}
						onclick={() => (bulkDeleteOpen = true)}
					>
						删除所选
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
									aria-label={`选择 ${rowTitle(row)}`}
									class="size-4 rounded border"
								/>
							</label>
							{#if !row.isVisible}
								<Badge variant="secondary" class="absolute top-2 right-2 z-10 text-xs">
									<IconEyeOff class="mr-1 size-3" />
									隐藏
								</Badge>
							{/if}
							<button
								type="button"
								class="block w-full"
								onclick={() => (editingId = row.id)}
								aria-label="编辑 {row.slug}"
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
										<span title="内容引用处数">引用 {row.refCount}</span>
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
				<h2 class="text-sm font-medium">编辑照片</h2>
				<Button variant="ghost" size="sm" onclick={() => (editingId = null)}>关闭</Button>
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
						内容引用 {editing.refCount} 处{#if editing.tags.length}
							· 标签：{editing.tags.map((tag) => tag.name).join('、')}{/if}
					</p>
					<a
						class="inline-flex items-center gap-1 text-xs underline"
						href={`/photos/${editing.slug}`}
						target="_blank"
						rel="noreferrer"
					>
						<IconExternalLink class="size-3.5" />查看公开页（隐藏时为 404）
					</a>
				</div>
				<form method="POST" action="?/update" class="flex flex-col gap-3">
					<input type="hidden" name="id" value={editing.id} />
					<div class="grid gap-3 md:grid-cols-3">
						{#each LOCALE_LABELS as locale (locale.key)}
							<label class="grid gap-1 text-xs text-muted-foreground">
								标题 · {locale.label}
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
								描述 · {locale.label}
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
							拍摄时间
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
							公开可见
						</label>
					</div>
					<label class="grid gap-1 text-xs text-muted-foreground">
						标签（逗号分隔；留空即清空）
						<input
							name="tags"
							value={editing.tags.map((tag) => tag.name).join(', ')}
							class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
						/>
					</label>
					<div class="flex items-center gap-2">
						<Button type="submit" size="sm">保存</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="text-destructive"
							onclick={() => (deleteTarget = editing)}
						>
							<IconTrash data-icon="inline-start" />
							移出图床
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
			<AlertDialog.Title>移出图床？</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.slug}”
				将从图床移除；底层文件默认保留（内容资产不删）。可勾选同时删除文件——仅当文件未被任何内容引用时才会真正删除。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/delete">
			<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
			<label class="flex items-center gap-2 py-2 text-sm">
				<input type="checkbox" name="removeFile" value="1" class="size-4 rounded border" />
				同时删除文件（未被内容引用时）
			</label>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>取消</AlertDialog.Cancel>
				<AlertDialog.Action type="submit">移出</AlertDialog.Action>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={bulkDeleteOpen} onOpenChange={(open) => (bulkDeleteOpen = open)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>删除所选 {selectedIds.length} 张？</AlertDialog.Title>
			<AlertDialog.Description>
				仅移出图床；底层文件保留（需要清理文件请到内容资产页）。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/bulk">
			{#each selectedIds as id (id)}
				<input type="hidden" name="ids" value={id} />
			{/each}
			<input type="hidden" name="op" value="delete" />
			<AlertDialog.Footer>
				<AlertDialog.Cancel>取消</AlertDialog.Cancel>
				<AlertDialog.Action type="submit">删除</AlertDialog.Action>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>

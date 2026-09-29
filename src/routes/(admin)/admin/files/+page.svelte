<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageProps } from './$types';
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
	};
	type PurgeList = Array<{ objectKey: string; fileName: string; status: string; ageDays: number }>;

	const actionData = $derived(
		(form ?? {}) as {
			message?: string;
			uploadResults?: UploadResult[];
			audit?: AuditReport;
			purge?: PurgeList;
		}
	);

	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let copiedId = $state<string | null>(null);

	const deletedFlash = $derived(page.url.searchParams.get('deleted') === '1');

	const STATUS_LABELS: Record<string, string> = {
		pending: '待引用',
		attached: '已引用',
		detached: '已解挂'
	};
	const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
		pending: 'outline',
		attached: 'default',
		detached: 'secondary'
	};
	const ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.tif,.tiff,.pdf,.zip,.txt,.md';

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * Public content URL: webp `@full` for transcoded photos, the ORIGINAL
	 * key for GIFs (plan §4.3 直通 — the original is the public tier) and for
	 * attachments (public once registered; /i enforces the registry check).
	 */
	function publicUrl(row: FileRow): string {
		if (row.mimeType === 'image/gif') return `/i/${row.objectKey}`;
		return `/i/${row.objectKey}${row.mimeType.startsWith('image/') ? '@full' : ''}`;
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
	<title>文件 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if deletedFlash}
		<div
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
		>
			文件已删除。
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
			{#each actionData.uploadResults as result (result.fileName)}
				<p class:opacity-60={!result.ok}>
					{result.ok ? '✓' : '✗'}
					{result.fileName}
					{#if result.ok && result.file?.deduplicated}（重复内容，复用了已有文件）{/if}
					{#if !result.ok}— {result.message ?? result.code}{/if}
				</p>
			{/each}
		</div>
	{/if}

	<section class="rounded-xl border bg-background p-4">
		<h2 class="mb-3 text-sm font-medium">上传（≤ {data.limits.maxBatch} 个/批，单文件 ≤ 25MB）</h2>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			class="flex flex-wrap items-center gap-3"
		>
			<input
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
				类型
				<select
					name="kind"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.kind === ''}>全部</option>
					<option value="image" selected={data.filters.kind === 'image'}>图片</option>
					<option value="file" selected={data.filters.kind === 'file'}>文件</option>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				状态
				<select
					name="status"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.status === ''}>全部</option>
					<option value="pending" selected={data.filters.status === 'pending'}>待引用</option>
					<option value="attached" selected={data.filters.status === 'attached'}>已引用</option>
					<option value="detached" selected={data.filters.status === 'detached'}>已解挂</option>
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				关键词
				<input
					name="keyword"
					value={data.filters.keyword}
					placeholder="文件名"
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
					name="orphan"
					value="1"
					checked={data.filters.orphan}
					class="size-4 rounded border"
				/>
				仅游离（超 TTL 孤儿）
			</label>
			<Button type="submit" variant="secondary" size="sm">筛选</Button>
		</form>

		{#if data.files.length === 0}
			<Empty class="py-12">
				<div class="flex flex-col items-center gap-1">
					<h3 class="text-lg font-semibold tracking-tight">暂无文件</h3>
					<p class="text-sm text-muted-foreground">
						上传的图片与文档会出现在这里（内容寻址登记表）。
					</p>
				</div>
			</Empty>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-14">预览</Table.Head>
							<Table.Head>文件</Table.Head>
							<Table.Head class="hidden w-28 md:table-cell">尺寸</Table.Head>
							<Table.Head class="w-24">大小</Table.Head>
							<Table.Head class="w-24">状态</Table.Head>
							<Table.Head class="hidden w-24 sm:table-cell">引用</Table.Head>
							<Table.Head class="hidden w-40 lg:table-cell">上传时间</Table.Head>
							<Table.Head class="w-44 text-right">操作</Table.Head>
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
												: `/i/${row.objectKey}@thumb`}
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
									{#if row.isPhoto}<IconPhoto class="ml-1 inline size-3.5" />{/if}
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
											aria-label="预览"
										>
											<IconExternalLink class="size-4" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											onclick={() => copyUrl(row)}
											aria-label="复制 URL"
										>
											<IconCopy class="size-4" />
										</Button>
										{#if copiedId === row.id}
											<span class="text-xs text-emerald-600 dark:text-emerald-400">已复制</span>
										{/if}
										<Button
											variant="ghost"
											size="icon"
											class="size-8"
											href="/i/{row.objectKey}"
											download={row.fileName}
											aria-label="下载原件"
										>
											<IconDownload class="size-4" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="size-8 text-destructive"
											onclick={() => (deleteTarget = { id: row.id, name: row.fileName })}
											aria-label="删除"
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
		<h2 class="mb-1 text-sm font-medium">三检托底（只读）</h2>
		<p class="mb-3 text-xs text-muted-foreground">
			孤儿 = 无引用 · 非图床 · 超 TTL；破链 = 内容引用 /i/&lt;key&gt; 但登记表无行；对象缺失 =
			有行无物。实际清理走 CLI（<code>pnpm media:purge</code>，默认 dry-run）。
		</p>
		<div class="flex flex-wrap gap-3">
			<form method="POST" action="?/audit">
				<Button type="submit" variant="secondary" size="sm">
					<IconRefresh data-icon="inline-start" />
					运行巡检
				</Button>
			</form>
			<form method="POST" action="?/purgePreview">
				<Button type="submit" variant="outline" size="sm">清理预演（dry-run）</Button>
			</form>
		</div>

		{#if actionData.audit}
			<div class="mt-4 space-y-2 text-sm">
				<p class="text-xs text-muted-foreground">生成于 {actionData.audit.generatedAt}</p>
				<p>
					① 孤儿：{actionData.audit.orphans.length} · ② 破链：{actionData.audit.brokenLinks.length} ·
					③ 对象缺失：{actionData.audit.missingObjects.length}
				</p>
				{#each actionData.audit.orphans as orphan (orphan.objectKey)}
					<p class="text-xs text-muted-foreground">
						① {orphan.objectKey}（{orphan.fileName}，{orphan.ageDays} 天）
					</p>
				{/each}
				{#each actionData.audit.brokenLinks as link (link.key + link.refId)}
					<p class="text-xs text-muted-foreground">② {link.key} ← {link.refType}:{link.refId}</p>
				{/each}
				{#each actionData.audit.missingObjects as row (row.objectKey)}
					<p class="text-xs text-muted-foreground">③ {row.objectKey}（{row.fileName}）</p>
				{/each}
			</div>
		{/if}

		{#if actionData.purge}
			<div class="mt-4 space-y-2 text-sm">
				<p>清理预演：{actionData.purge.length} 个候选（只读，未删除）</p>
				{#each actionData.purge as candidate (candidate.objectKey)}
					<p class="text-xs text-muted-foreground">
						{candidate.objectKey}（{candidate.fileName}，{candidate.status}，{candidate.ageDays} 天）
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
			<AlertDialog.Title>删除文件？</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.name}” 将连同全部派生对象一起删除；被内容或图床引用时会被阻止。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form method="POST" action="?/delete">
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Action type="submit">删除</AlertDialog.Action>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { Separator } from '$lib/components/ui/separator';
	import { formatDateTime } from '$lib/utils/i18n';
	import type { PageData } from './$types';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconEyeOff from '@tabler/icons-svelte-runes/icons/eye-off';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } =
		$props();

	type PageRow = (typeof data.pages)[number];

	// Default rows hide through a confirmation (three menu surfaces disappear,
	// direct access stays); deleting them is refused by the server as well.
	let hideTarget = $state<PageRow | null>(null);
	let deleteTarget = $state<PageRow | null>(null);

	// Writable derived (Svelte 5.25+): the refresh button clears the banner by
	// assignment; the next submission resyncs it from `form`.
	let errorText = $derived(form?.error ?? null);

	// ▲/▼ dead zones (P2 review): defaults render first, so the first extra
	// row cannot move up and the last default row cannot move down.
	let submitting = $state(false);
	const firstExtraIndex = $derived(data.pages.findIndex((row) => !row.isDefault));
	const lastDefaultIndex = $derived(
		data.pages.reduce((last, row, index) => (row.isDefault ? index : last), -1)
	);
</script>

<svelte:head>
	<title>页面管理 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if errorText}
		<div
			role="alert"
			class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{errorText}
		</div>
	{/if}

	<div class="relative flex h-10 shrink-0 items-center border-b">
		<div class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
			共 {data.pages.length} 页 · 默认页置前，其余按排序值。“新增”随 md 编辑器批次（P5）开放。
		</div>
		<div class="absolute top-0 right-0 flex h-full items-center pr-2">
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton
				onclick={() => {
					errorText = null;
					invalidateAll();
				}}
			/>
		</div>
	</div>

	{#if data.pages.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无页面</h3>
				<p class="text-sm text-muted-foreground">种子页缺失——运行 db:ensure-pages 恢复默认两页。</p>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="table-fixed">
				<Table.Header>
					<Table.Row class="border-border">
						<Table.Head>标题</Table.Head>
						<Table.Head class="hidden w-44 sm:table-cell">Slug</Table.Head>
						<Table.Head class="hidden w-20 md:table-cell">状态</Table.Head>
						<Table.Head class="w-28">排序</Table.Head>
						<Table.Head class="hidden w-36 lg:table-cell">更新时间</Table.Head>
						<Table.Head class="w-28 text-right">操作</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.pages as page, index (page.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 items-center gap-2">
									<a
										href="/admin/pages/edit?id={page.id}"
										class="truncate font-medium hover:text-primary"
									>
										{page.title}
									</a>
									{#if page.isDefault}
										<Badge variant="secondary" class="shrink-0 text-xs">默认</Badge>
									{/if}
									<Badge variant="outline" class="shrink-0 text-xs">
										{page.externalUrl ? '外链' : '站内'}
									</Badge>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-44 sm:table-cell">
								<span class="font-mono text-xs text-muted-foreground">{page.slug}</span>
							</Table.Cell>
							<Table.Cell class="hidden w-20 md:table-cell">
								<Badge
									variant={page.status === 'visible' ? 'default' : 'secondary'}
									class="text-xs"
								>
									{page.status === 'visible' ? '可见' : '隐藏'}
								</Badge>
							</Table.Cell>
							<Table.Cell class="w-28">
								<div class="flex items-center gap-1">
									<form method="POST" action="?/move" use:enhance class="flex items-center">
										<input type="hidden" name="id" value={page.id} />
										<Button
											type="submit"
											name="direction"
											value="up"
											variant="ghost"
											size="icon"
											class="size-6"
											aria-label="上移"
											disabled={index === 0 || index === firstExtraIndex}
										>
											<IconArrowUp class="size-3.5" />
										</Button>
										<Button
											type="submit"
											name="direction"
											value="down"
											variant="ghost"
											size="icon"
											class="size-6"
											aria-label="下移"
											disabled={index === data.pages.length - 1 || index === lastDefaultIndex}
										>
											<IconArrowDown class="size-3.5" />
										</Button>
									</form>
									<span class="font-mono text-xs text-muted-foreground">{page.sortOrder}</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-36 text-xs text-muted-foreground lg:table-cell">
								{formatDateTime(new Date(page.updatedAt), {
									dateStyle: 'short',
									timeStyle: 'short'
								})}
							</Table.Cell>
							<Table.Cell class="w-28 text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										href="/admin/pages/edit?id={page.id}"
										aria-label="编辑"
									>
										<IconPencil class="size-4" />
									</Button>
									{#if page.status === 'visible'}
										{#if page.isDefault}
											<Button
												variant="ghost"
												size="icon"
												class="size-8"
												aria-label="隐藏"
												onclick={() => (hideTarget = page)}
											>
												<IconEyeOff class="size-4" />
											</Button>
										{:else}
											<form method="POST" action="?/setStatus" use:enhance>
												<input type="hidden" name="id" value={page.id} />
												<input type="hidden" name="status" value="hidden" />
												<Button
													type="submit"
													variant="ghost"
													size="icon"
													class="size-8"
													aria-label="隐藏"
												>
													<IconEyeOff class="size-4" />
												</Button>
											</form>
										{/if}
									{:else}
										<form method="POST" action="?/setStatus" use:enhance>
											<input type="hidden" name="id" value={page.id} />
											<input type="hidden" name="status" value="visible" />
											<Button
												type="submit"
												variant="ghost"
												size="icon"
												class="size-8"
												aria-label="显示"
											>
												<IconEye class="size-4" />
											</Button>
										</form>
									{/if}
									{#if !page.isDefault}
										<Button
											variant="ghost"
											size="icon"
											class="size-8 text-destructive hover:text-destructive"
											aria-label="删除"
											onclick={() => (deleteTarget = page)}
										>
											<IconTrash class="size-4" />
										</Button>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<AlertDialog.Root open={hideTarget !== null} onOpenChange={(open) => !open && (hideTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>隐藏默认页？</AlertDialog.Title>
			<AlertDialog.Description>
				“{hideTarget?.title}” 将从首页卡片、移动端菜单与页脚一起消失（直达仍可访问，不 404）。
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/setStatus"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update();
						submitting = false;
						if (result.type === 'success') hideTarget = null;
					};
				}}
			>
				<input type="hidden" name="id" value={hideTarget?.id ?? ''} />
				<input type="hidden" name="status" value="hidden" />
				<AlertDialog.Action type="submit" disabled={submitting}>隐藏</AlertDialog.Action>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => !open && (deleteTarget = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>删除页面？</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.title}” 将被删除。{deleteTarget?.hasContent
					? 'URL 将 404（数据即页面）。'
					: '入口将下线；如果代码路由存在，直达仍可访问。'}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/delete"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update();
						submitting = false;
						if (result.type === 'success') deleteTarget = null;
					};
				}}
			>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Action type="submit" disabled={submitting}>删除</AlertDialog.Action>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

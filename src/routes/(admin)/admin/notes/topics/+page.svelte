<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import type { PageData } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Empty } from '$lib/components/ui/empty';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } =
		$props();

	let selectedId = $state<string | null>(page.url.searchParams.get('id'));

	function selectTopic(id: string) {
		selectedId = id;
		goto(`?id=${id}`, { replaceState: true });
	}

	function backToList() {
		selectedId = null;
		goto('.', { replaceState: true });
	}

	let dialogOpen = $state(false);
	let dialogMode = $state<'create' | 'edit'>('create');
	let editName = $state('');
	let editSlug = $state('');
	let editDescription = $state('');
	let editIcon = $state('');
	let editSortOrder = $state('0');

	const selectedTopic = $derived(data.topics.find((t) => t.id === selectedId) ?? null);

	function openCreate() {
		dialogMode = 'create';
		editName = '';
		editSlug = '';
		editDescription = '';
		editIcon = '';
		editSortOrder = String(data.topics.length);
		dialogOpen = true;
	}

	function openEdit() {
		if (!selectedTopic) return;
		dialogMode = 'edit';
		editName = selectedTopic.name;
		editSlug = selectedTopic.slug;
		editDescription = selectedTopic.description;
		editIcon = selectedTopic.icon ?? '';
		editSortOrder = String(selectedTopic.sortOrder);
		dialogOpen = true;
	}

	/** Close the dialog once an action succeeds; failures keep it open under the banner. */
	function closeOnSuccess() {
		return async ({
			result,
			update
		}: {
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
		}) => {
			if (result.type !== 'failure') dialogOpen = false;
			await update();
		};
	}

	function onNameInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		editName = input.value;
		if (dialogMode === 'create') {
			editSlug = editName
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, '-')
				.replace(/^-|-$/g, '');
		}
	}

	/** Extract first 2 characters from topic name for avatar display */
	function avatarText(name: string): string {
		return name.slice(0, 2);
	}
</script>

<svelte:head>
	<title>专栏管理 - Lair Admin</title>
</svelte:head>

{#if form?.error}
	<div
		role="alert"
		class="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
	>
		<span class="shrink-0 font-medium">无法完成:</span>
		<span class="min-w-0">{form.error}</span>
	</div>
{/if}

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if selectedTopic}
		{@const topic = selectedTopic}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					class="size-8"
					onclick={backToList}
					aria-label="返回列表"
				>
					<IconArrowLeft data-icon="inline-start" />
				</Button>
				<span class="text-sm font-medium">专栏详情</span>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<Button variant="outline" size="sm" onclick={openEdit}>
					<IconPencil data-icon="inline-start" />编辑
				</Button>
				<form method="POST" action="?/delete" use:enhance>
					<input type="hidden" name="id" value={topic.id} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
					>
						<IconTrash data-icon="inline-start" />删除
					</Button>
				</form>
			</div>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			<section class="mb-6 rounded border bg-muted/50 p-4">
				<div class="flex items-start gap-4">
					<div
						class="flex size-14 shrink-0 items-center justify-center rounded bg-muted text-lg font-semibold"
					>
						{avatarText(topic.name)}
					</div>
					<div class="min-w-0 flex-1">
						<h3 class="truncate text-lg font-semibold">{topic.name}</h3>
						<p class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
							<IconHash class="size-3" />{topic.slug}
						</p>
						<p class="mt-3 text-sm text-muted-foreground">{topic.description}</p>
					</div>
				</div>
			</section>
			<section>
				<p class="rounded border bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
					{data.noteCounts[topic.id] ?? 0} 篇手记来自此专栏
				</p>
			</section>
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<IconHash class="size-4 shrink-0 text-muted-foreground" />
				<h2 class="truncate text-sm font-semibold">专栏列表</h2>
				<span class="text-xs text-muted-foreground tabular-nums">{data.topics.length} 个</span>
			</div>
			<Button size="sm" variant="outline" onclick={openCreate}>
				<IconPlus data-icon="inline-start" />新建
			</Button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.topics.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">暂无专栏</h3>
						<p class="text-sm text-muted-foreground">创建专栏来归类你的手记</p>
					</div>
				</Empty>
			{:else}
				{#each data.topics as topic (topic.id)}
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
							selectedId === topic.id && 'bg-muted/50'
						)}
						onclick={() => selectTopic(topic.id)}
					>
						<div
							class="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold"
						>
							{avatarText(topic.name)}
						</div>
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-medium">{topic.name}</h3>
							<p
								class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />{topic.slug}
							</p>
						</div>
						<span class="text-xs text-muted-foreground tabular-nums"
							>{data.noteCounts[topic.id] ?? 0} 篇</span
						>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root>
		<!-- ===== 左侧：专栏列表 ===== -->
		<MasterDetail.Pane side="master" class="flex-1 lg:max-w-[340px] xl:max-w-[380px]">
			<MasterDetail.Header icon={IconHash} title="专栏列表" count={data.topics.length}>
				<Button size="sm" variant="outline" onclick={openCreate}>
					<IconPlus data-icon="inline-start" />
					新建
				</Button>
			</MasterDetail.Header>

			<MasterDetail.List>
				{#if data.topics.length === 0}
					<Empty class="py-12">
						<div class="flex flex-col items-center gap-1">
							<h3 class="text-lg font-semibold tracking-tight">暂无专栏</h3>
							<p class="text-sm text-muted-foreground">创建专栏来归类你的手记</p>
						</div>
					</Empty>
				{:else}
					<div>
						{#each data.topics as topic (topic.id)}
							<MasterDetail.Item
								selected={selectedId === topic.id}
								onclick={() => selectTopic(topic.id)}
							>
								<div
									class="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold"
								>
									{avatarText(topic.name)}
								</div>
								<div class="min-w-0 flex-1">
									<h3 class="truncate text-sm font-medium">{topic.name}</h3>
									<p
										class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground"
									>
										<IconHash class="size-3 shrink-0" />
										{topic.slug}
									</p>
								</div>
								<span class="text-xs text-muted-foreground tabular-nums"
									>{data.noteCounts[topic.id] ?? 0} 篇</span
								>
							</MasterDetail.Item>
						{/each}
					</div>
				{/if}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- ===== 右侧：专栏详情 ===== -->
		<MasterDetail.Pane side="detail" class="bg-surface-card hidden lg:flex">
			{#if selectedTopic}
				{@const topic = selectedTopic}
				<MasterDetail.Header title="专栏详情">
					<div class="flex items-center gap-1">
						<form method="POST" action="?/move" use:enhance>
							<input type="hidden" name="id" value={topic.id} />
							<input type="hidden" name="direction" value="up" />
							<Button type="submit" variant="ghost" size="icon" class="size-8" aria-label="上移">
								<IconArrowUp class="size-4" />
							</Button>
						</form>
						<form method="POST" action="?/move" use:enhance>
							<input type="hidden" name="id" value={topic.id} />
							<input type="hidden" name="direction" value="down" />
							<Button type="submit" variant="ghost" size="icon" class="size-8" aria-label="下移">
								<IconArrowDown class="size-4" />
							</Button>
						</form>
					</div>
					<Button variant="outline" size="sm" onclick={openEdit}>
						<IconPencil data-icon="inline-start" />
						编辑
					</Button>
					<form method="POST" action="?/delete" use:enhance>
						<input type="hidden" name="id" value={topic.id} />
						<Button
							type="submit"
							variant="outline"
							size="sm"
							class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
						>
							<IconTrash data-icon="inline-start" />
							删除
						</Button>
					</form>
				</MasterDetail.Header>

				<div class="min-h-0 flex-1 overflow-auto p-5">
					<section class="mb-6 rounded border bg-muted/50 p-4">
						<div class="flex items-start gap-4">
							<div
								class="flex size-14 shrink-0 items-center justify-center rounded bg-muted text-lg font-semibold"
							>
								{avatarText(topic.name)}
							</div>
							<div class="min-w-0 flex-1">
								<h3 class="truncate text-lg font-semibold">{topic.name}</h3>
								<p
									class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
								>
									<IconHash class="size-3" />
									{topic.slug}
								</p>
								<p class="mt-3 text-sm text-muted-foreground">{topic.description}</p>
								<p class="mt-2 text-xs text-muted-foreground">
									图标：{topic.icon ?? '（未设置）'} · 排序值：{topic.sortOrder}
								</p>
							</div>
						</div>
					</section>

					<section>
						<p
							class="rounded border bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground"
						>
							{data.noteCounts[topic.id] ?? 0} 篇手记来自此专栏
						</p>
					</section>
				</div>
			{:else}
				<div class="flex flex-1 items-center justify-center p-8">
					<div class="flex flex-col items-center gap-2 text-center">
						<IconHash class="size-10 text-muted-foreground/40" />
						<h3 class="text-lg font-semibold tracking-tight">选择一个专栏</h3>
						<p class="text-sm text-muted-foreground">从左侧列表中选择专栏以查看详情</p>
					</div>
				</div>
			{/if}
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

<!-- 新建/编辑专栏对话框 -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{dialogMode === 'create' ? '新建专栏' : '编辑专栏'}</Dialog.Title>
			<Dialog.Description>
				{dialogMode === 'create' ? '创建一个新的手记专栏' : '修改专栏信息'}
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/{dialogMode === 'create' ? 'create' : 'update'}"
			use:enhance={closeOnSuccess}
		>
			{#if dialogMode === 'edit' && selectedTopic}
				<input type="hidden" name="id" value={selectedTopic.id} />
			{/if}
			<div class="flex flex-col gap-4 px-6 pb-4">
				<div class="flex flex-col gap-1.5">
					<label for="topic-name" class="text-sm font-medium">名称</label>
					<Input
						id="topic-name"
						name="name"
						placeholder="专栏名称"
						bind:value={editName}
						oninput={onNameInput}
						required
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label for="topic-slug" class="text-sm font-medium">Slug</label>
					<Input
						id="topic-slug"
						name="slug"
						placeholder="topic-slug"
						bind:value={editSlug}
						required
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label for="topic-description" class="text-sm font-medium">描述</label>
					<Textarea
						id="topic-description"
						name="description"
						placeholder="专栏简介（可留空）"
						bind:value={editDescription}
						rows={3}
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label for="topic-icon" class="text-sm font-medium">图标（Tabler 名）</label>
					<Input
						id="topic-icon"
						name="icon"
						placeholder="notebook"
						list="topic-icon-options"
						bind:value={editIcon}
					/>
					<datalist id="topic-icon-options">
						{#each NAV_ICON_NAMES as iconName (iconName)}
							<option value={iconName}></option>
						{/each}
					</datalist>
					<p class="text-xs text-muted-foreground">前台仅渲染白名单内的图标，其余留空显示。</p>
				</div>
				<div class="flex flex-col gap-1.5">
					<label for="topic-sort" class="text-sm font-medium">排序值</label>
					<Input id="topic-sort" name="sortOrder" type="number" bind:value={editSortOrder} />
					<p class="text-xs text-muted-foreground">数值小的在前；也可用详情页 ▲/▼ 调整。</p>
				</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (dialogOpen = false)}>取消</Button>
				<Button type="submit">{dialogMode === 'create' ? '创建' : '保存'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

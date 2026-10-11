<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Empty } from '$lib/components/ui/empty';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';

	let { data }: { data: PageData } = $props();

	let selectedId = $state<string | null>(page.url.searchParams.get('id'));

	function selectCategory(id: string) {
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

	const selectedCategory = $derived(data.categories.find((c) => c.id === selectedId) ?? null);

	function openCreate() {
		dialogMode = 'create';
		editName = '';
		editSlug = '';
		dialogOpen = true;
	}

	function openEdit() {
		if (!selectedCategory) return;
		dialogMode = 'edit';
		editName = selectedCategory.name;
		editSlug = selectedCategory.slug;
		dialogOpen = true;
	}

	function onNameInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		editName = input.value;
		if (dialogMode === 'create') {
			editSlug = editName
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
		}
	}
</script>

<svelte:head>
	<title>{m.admin_categories_title()} - Lair Admin</title>
</svelte:head>

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if selectedCategory}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					class="size-8"
					onclick={backToList}
					aria-label={m.admin_common_back_to_list()}
				>
					<IconArrowLeft data-icon="inline-start" />
				</Button>
				<span class="text-sm font-medium">{m.admin_categories_detail()}</span>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<Button variant="outline" size="sm" onclick={openEdit}>
					<IconPencil data-icon="inline-start" />{m.admin_common_edit()}
				</Button>
				<form method="POST" action="?/delete" use:enhance>
					<input type="hidden" name="id" value={selectedCategory.id} />
					<Button
						variant="outline"
						size="sm"
						class="border-destructive/20 text-destructive hover:bg-destructive/10"
					>
						<IconTrash data-icon="inline-start" />{m.admin_common_delete()}
					</Button>
				</form>
			</div>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			<section class="mb-6 flex items-start gap-4 rounded-lg border p-4">
				<div
					class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
				>
					<IconFolder class="size-6" />
				</div>
				<div class="min-w-0">
					<h3 class="truncate text-lg font-semibold">{selectedCategory.name}</h3>
					<p class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
						<IconHash class="size-3" />{selectedCategory.slug}
					</p>
					<p class="mt-2 text-xs text-muted-foreground">
						{m.admin_categories_post_count({ count: data.postCounts[selectedCategory.id] ?? 0 })}
					</p>
				</div>
			</section>
			<section>
				<div class="mb-3 flex items-center justify-between">
					<h3 class="text-sm font-medium">{m.admin_categories_posts_heading()}</h3>
					<span class="text-xs text-muted-foreground"
						>{m.admin_categories_post_count({ count: 0 })}</span
					>
				</div>
				<div class="overflow-hidden rounded-lg border">
					<Empty class="py-8">
						<p class="text-sm text-muted-foreground">{m.admin_categories_no_posts()}</p>
					</Empty>
				</div>
			</section>
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<IconFolder class="size-4 shrink-0 text-muted-foreground" />
				<h2 class="truncate text-sm font-semibold">{m.admin_categories_tags_heading()}</h2>
				<span class="text-xs text-muted-foreground tabular-nums"
					>{m.admin_categories_tags_count({ count: data.categories.length })}</span
				>
			</div>
			<Button variant="outline" size="sm" onclick={openCreate}>
				<IconPlus data-icon="inline-start" />{m.admin_common_new()}
			</Button>
		</div>
		<div class="border-b px-4 py-2">
			<h3 class="text-xs font-medium text-muted-foreground uppercase">
				{m.nav_posts_categories()}
			</h3>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.categories.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_categories_empty()}</p>
				</Empty>
			{:else}
				{#each data.categories as cat (cat.id)}
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
							selectedId === cat.id && 'bg-muted/50'
						)}
						onclick={() => selectCategory(cat.id)}
					>
						<IconFolder class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h4 class="truncate text-sm font-medium">{cat.name}</h4>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />{cat.slug}
							</p>
						</div>
						<span class="text-xs text-muted-foreground tabular-nums"
							>{data.postCounts[cat.id] ?? 0}</span
						>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root class="h-[calc(100vh-10rem)]">
		<!-- 侧边栏：分类列表 -->
		<MasterDetail.Pane side="master" class="w-80 shrink-0">
			<MasterDetail.Header
				icon={IconFolder}
				title={m.admin_categories_tags_heading()}
				count={data.categories.length}
			>
				<Button variant="outline" size="sm" onclick={openCreate}>
					<IconPlus data-icon="inline-start" />
					{m.admin_common_new()}
				</Button>
			</MasterDetail.Header>
			<MasterDetail.List>
				<div class="border-b px-4 py-2">
					<h3 class="text-xs font-medium text-muted-foreground uppercase">
						{m.nav_posts_categories()}
					</h3>
				</div>
				{#if data.categories.length === 0}
					<Empty class="py-8">
						<p class="text-sm text-muted-foreground">{m.admin_categories_empty()}</p>
					</Empty>
				{:else}
					{#each data.categories as cat (cat.id)}
						<MasterDetail.Item
							selected={selectedId === cat.id}
							onclick={() => selectCategory(cat.id)}
						>
							<IconFolder class="size-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<h4 class="truncate text-sm font-medium">{cat.name}</h4>
								<p
									class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
								>
									<IconHash class="size-3 shrink-0" />
									{cat.slug}
								</p>
							</div>
							<span class="text-xs text-muted-foreground tabular-nums"
								>{data.postCounts[cat.id] ?? 0}</span
							>
						</MasterDetail.Item>
					{/each}
				{/if}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- 主面板：分类详情 -->
		<MasterDetail.Pane side="detail">
			{#if selectedCategory}
				<MasterDetail.Header title={m.admin_categories_detail()}>
					<Button variant="outline" size="sm" onclick={openEdit}>
						<IconPencil data-icon="inline-start" />
						{m.admin_common_edit()}
					</Button>
					<form method="POST" action="?/delete" use:enhance>
						<input type="hidden" name="id" value={selectedCategory.id} />
						<Button
							variant="outline"
							size="sm"
							class="border-destructive/20 text-destructive hover:bg-destructive/10"
						>
							<IconTrash data-icon="inline-start" />
							{m.admin_common_delete()}
						</Button>
					</form>
				</MasterDetail.Header>
				<div class="flex-1 overflow-y-auto p-5">
					<section class="mb-6 flex items-start gap-4 rounded-lg border p-4">
						<div
							class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<IconFolder class="size-6" />
						</div>
						<div class="min-w-0">
							<h3 class="truncate text-lg font-semibold">{selectedCategory.name}</h3>
							<p
								class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3" />
								{selectedCategory.slug}
							</p>
							<p class="mt-2 text-xs text-muted-foreground">
								{m.admin_categories_post_count({
									count: data.postCounts[selectedCategory.id] ?? 0
								})}
							</p>
						</div>
					</section>

					<section>
						<div class="mb-3 flex items-center justify-between">
							<h3 class="text-sm font-medium">{m.admin_categories_posts_heading()}</h3>
							<span class="text-xs text-muted-foreground"
								>{m.admin_categories_post_count({ count: 0 })}</span
							>
						</div>
						<div class="overflow-hidden rounded-lg border">
							<Empty class="py-8">
								<p class="text-sm text-muted-foreground">{m.admin_categories_no_posts()}</p>
							</Empty>
						</div>
					</section>
				</div>
			{:else}
				<div class="flex flex-1 items-center justify-center">
					<Empty>
						<div class="flex flex-col items-center gap-1">
							<IconFolder class="size-8 text-muted-foreground/40" />
							<h3 class="text-lg font-semibold tracking-tight">{m.admin_categories_select()}</h3>
							<p class="text-sm text-muted-foreground">{m.admin_categories_select_hint()}</p>
						</div>
					</Empty>
				</div>
			{/if}
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

<!-- 新建/编辑分类对话框 -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title
				>{dialogMode === 'create'
					? m.admin_categories_dialog_create()
					: m.admin_categories_dialog_edit()}</Dialog.Title
			>
			<Dialog.Description>
				{dialogMode === 'create'
					? m.admin_categories_dialog_create_desc()
					: m.admin_categories_dialog_edit_desc()}
			</Dialog.Description>
		</Dialog.Header>
		<form method="POST" action="?/{dialogMode === 'create' ? 'create' : 'update'}" use:enhance>
			{#if dialogMode === 'edit' && selectedCategory}
				<input type="hidden" name="id" value={selectedCategory.id} />
			{/if}
			<div class="flex flex-col gap-4 px-6 pb-4">
				<div class="flex flex-col gap-1.5">
					<label for="cat-name" class="text-sm font-medium">{m.admin_categories_name()}</label>
					<Input
						id="cat-name"
						name="name"
						placeholder={m.admin_categories_name_placeholder()}
						bind:value={editName}
						oninput={onNameInput}
						required
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label for="cat-slug" class="text-sm font-medium">Slug</label>
					<Input
						id="cat-slug"
						name="slug"
						placeholder="category-slug"
						bind:value={editSlug}
						required
					/>
				</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (dialogOpen = false)}
					>{m.admin_common_cancel()}</Button
				>
				<Button type="submit"
					>{dialogMode === 'create' ? m.admin_common_create() : m.admin_common_save()}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

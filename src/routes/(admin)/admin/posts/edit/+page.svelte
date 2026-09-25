<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionData, PageData } from './$types';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Button } from '$lib/components/ui/button';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Dialog from '$lib/components/ui/dialog';
	import { MarkdownEditor } from '$lib/components/markdown';
	import { formatDateTime } from '$lib/utils/i18n';
	import { normalizeSlug } from '$lib/utils/slug';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconFileDescription from '@tabler/icons-svelte-runes/icons/file-description';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let title = $state('');
	let slug = $state('');
	let slugTouched = $state(false);
	let categoryId = $state('');
	let summary = $state('');
	let tags = $state('');
	let contentMarkdown = $state('');
	let isPublished = $state(true);
	let slugDialogOpen = $state(false);
	let settingsOpen = $state(false);
	let justSaved = $state(false);

	function applyPost(p: typeof data.post) {
		title = p?.title ?? '';
		slug = p?.slug ?? '';
		slugTouched = !!p?.slug;
		categoryId = p?.categoryId ?? '';
		summary = p?.summary ?? '';
		tags = p?.tags ?? '';
		contentMarkdown = p?.content ?? '';
		isPublished = p?.isPublished ?? true;
	}

	function currentFields() {
		return { title, slug, categoryId, summary, tags, content: contentMarkdown, isPublished };
	}

	// Initialize once from load data so the editor mounts with content.
	// Later data changes flow through the postKey effect below.
	// svelte-ignore state_referenced_locally
	applyPost(data.post);
	let baseline = $state(JSON.stringify(currentFields()));

	const postKey = $derived(data.post ? `${data.post.id}@${data.post.updatedAt ?? ''}` : 'new');
	// svelte-ignore state_referenced_locally
	let loadedKey = $state(postKey);

	const dirty = $derived(JSON.stringify(currentFields()) !== baseline);

	// Repopulate fields when a different post version loads (e.g. after save).
	$effect(() => {
		if (loadedKey === postKey) return;
		loadedKey = postKey;
		if (!data.post) return;
		applyPost(data.post);
		baseline = JSON.stringify(currentFields());
	});

	// Show a transient saved notice when redirected back with ?saved=1.
	$effect(() => {
		if (page.url.searchParams.get('saved') !== '1') return;
		justSaved = true;
		setTimeout(() => (justSaved = false), 3000);
		const url = new URL(page.url);
		url.searchParams.delete('saved');
		replaceState(url.pathname + url.search, {});
	});

	// Slugs accept lowercase letters, digits and hyphens only.
	function onTitleInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		title = input.value;
		// Keep a manual or loaded slug untouched.
		if (!slugTouched) {
			slug = normalizeSlug(title.replace(/[^a-z0-9]+/g, '-'));
		}
	}

	function onSlugInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		slugTouched = true;
		slug = normalizeSlug(input.value);
	}

	const formErrorMessages = $derived(
		form?.errors ? (Object.values(form.errors).filter(Boolean) as string[]) : []
	);
</script>

<svelte:head>
	<title>{title ? `${title} - Lair Admin` : 'New Post - Lair Admin'}</title>
</svelte:head>

<svelte:window
	onbeforeunload={(e) => {
		if (dirty) {
			e.preventDefault();
			e.returnValue = '';
		}
	}}
/>

<form method="POST" use:enhance id="post-form" class="flex h-full min-h-0 min-w-0 flex-col">
	{#if data.post}
		<input type="hidden" name="id" value={data.post.id} />
	{/if}
	<!-- Main content area -->
	<main class="flex min-h-full min-w-0 flex-col bg-background">
		<!-- Header area: title + slug + separator -->
		<div class="mx-auto w-full max-w-5xl shrink-0 px-3 pt-8">
			<!-- Status bar -->
			<div
				class="group mb-3 flex min-h-7 items-center justify-between opacity-60 transition-opacity duration-200 hover:opacity-100"
			>
				<div class="flex min-w-0 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
					<span
						aria-hidden="true"
						class="inline-block size-1.5 shrink-0 rounded-full bg-emerald-500"
					></span>
					{#if data.post}
						<span class="truncate">
							{data.post.isPublished ? '已发布' : '草稿'} · 修改于
							{formatDateTime(new Date(data.post.updatedAt ?? data.post.createdAt), {
								dateStyle: 'short',
								timeStyle: 'short'
							})}
						</span>
					{:else}
						<span class="truncate">草稿 · 新文章</span>
					{/if}
					{#if justSaved}
						<span
							class="shrink-0 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400"
						>
							已保存
						</span>
					{/if}
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<!-- Settings button -->
					<button
						type="button"
						onclick={() => (settingsOpen = true)}
						class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
						aria-label="文章设置"
						title="文章设置"
					>
						<IconSettings class="size-3.5" />
					</button>

					<!-- Save button; publish state is set in the settings sheet -->
					<Button type="submit" size="sm" class="h-7 gap-1 px-2.5 text-xs">
						<IconDeviceFloppy class="size-3" />
						保存
					</Button>
				</div>
			</div>

			<!-- Form-level error banner -->
			{#if formErrorMessages.length > 0}
				<div
					role="alert"
					class="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					<span class="shrink-0 font-medium">保存失败:</span>
					<span class="min-w-0">{formErrorMessages.join('；')}</span>
				</div>
			{/if}

			<!-- Title input -->
			<div class="group">
				<input
					name="title"
					class="w-full border-0 bg-transparent px-0 py-0 text-3xl font-semibold tracking-tight text-neutral-950 outline-none placeholder:font-medium placeholder:text-neutral-300 dark:text-neutral-50 dark:placeholder:text-neutral-700"
					placeholder="输入标题..."
					required
					bind:value={title}
					oninput={onTitleInput}
				/>
				<!-- Slug button -->
				<div class="mt-1 flex items-center gap-2">
					<button
						type="button"
						class="-ml-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-opacity duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-accent/15"
						onclick={() => (slugDialogOpen = true)}
						aria-label="添加 slug"
					>
						<span class="truncate">{slug ? `/${slug}` : '+ 添加 slug'}</span>
						<IconPencil class="size-3 shrink-0" />
					</button>
					{#if title && !slug}
						<span class="text-xs text-destructive">请手动填写英文 slug</span>
					{/if}
				</div>
			</div>

			<hr class="my-4 border-0 border-t border-neutral-100 dark:border-neutral-800" />
		</div>

		<!-- Editor area -->
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3">
				{#key postKey}
					<!-- Remount reads server data directly: template updates run before
						the postKey effect, so contentMarkdown still holds the previous
						post's content at remount time. -->
					<MarkdownEditor
						initialMarkdown={data.post?.content ?? contentMarkdown}
						placeholder="输入正文..."
						stickyToolbar={true}
						borderless={true}
						class="min-h-0 flex-1"
						onChange={(detail) => {
							contentMarkdown = detail.markdown;
						}}
					/>
				{/key}
			</div>
		</div>
	</main>

	<!-- Hidden fields -->
	<input type="hidden" name="content" value={contentMarkdown} />
	<input type="hidden" name="slug" value={slug} />
	<input type="hidden" name="categoryId" value={categoryId} />
	<input type="hidden" name="summary" value={summary} />
	<input type="hidden" name="tags" value={tags} />
	<input type="hidden" name="isPublished" value={String(isPublished)} />
</form>

<!-- Slug Dialog -->
<Dialog.Root open={slugDialogOpen} onOpenChange={(v) => (slugDialogOpen = v)}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>设置 Slug</Dialog.Title>
				<Dialog.Description>URL 友好的标识符，用于文章链接。</Dialog.Description>
			</Dialog.Header>
			<div class="px-6 pb-2">
				<Input
					name="slug-input"
					placeholder="my-post-slug"
					class="font-mono"
					value={slug}
					oninput={onSlugInput}
				/>
				<p class="mt-1.5 text-xs text-muted-foreground">仅限小写英文、数字和连字符</p>
				{#if slug}
					<p class="mt-1.5 font-mono text-xs text-muted-foreground">
						预览: /posts/{slug}
					</p>
				{/if}
				{#if form?.errors?.slug}
					<p class="mt-1 text-sm text-destructive">{form.errors.slug}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Dialog.Close>取消</Dialog.Close>
				<Button onclick={() => (slugDialogOpen = false)}>确定</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<!-- Settings Sheet -->
<Sheet.Root open={settingsOpen} onOpenChange={(v) => (settingsOpen = v)}>
	<Sheet.Portal>
		<Sheet.Overlay />
		<Sheet.Content side="right" class="w-full sm:max-w-sm">
			<Sheet.Header>
				<Sheet.Title>文章设置</Sheet.Title>
				<Sheet.Description>配置文章的元数据信息。</Sheet.Description>
				<Sheet.Close
					class="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
				>
					<IconX class="size-4" />
					<span class="sr-only">关闭</span>
				</Sheet.Close>
			</Sheet.Header>
			<div class="flex flex-col gap-5 px-6 py-4">
				<!-- Category -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-category" class="flex items-center gap-1.5 text-sm font-medium">
						<IconCategory class="size-4 text-muted-foreground" />
						分类
					</label>
					<Select.Root type="single" bind:value={categoryId as never}>
						<Select.Trigger id="settings-category" class="w-full">
							{categoryId
								? (data.categories.find((c) => c.id === categoryId)?.name ?? '选择分类')
								: '选择分类'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Group>
									<Select.Label>分类</Select.Label>
									{#each data.categories as cat (cat.id)}
										<Select.Item value={cat.id}>{cat.name}</Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					{#if form?.errors?.categoryId}
						<p class="text-sm text-destructive">{form.errors.categoryId}</p>
					{/if}
				</div>

				<!-- Tags -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-tags" class="flex items-center gap-1.5 text-sm font-medium">
						<IconTag class="size-4 text-muted-foreground" />
						标签
					</label>
					<Input id="settings-tags" placeholder="svelte, typescript, tutorial" bind:value={tags} />
					<p class="text-xs text-muted-foreground">逗号分隔。</p>
				</div>

				<!-- Summary -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-summary" class="flex items-center gap-1.5 text-sm font-medium">
						<IconFileDescription class="size-4 text-muted-foreground" />
						摘要
					</label>
					<Textarea
						id="settings-summary"
						placeholder="文章简短描述..."
						bind:value={summary}
						rows={4}
					/>
				</div>

				<!-- Publish toggle -->
				<div class="flex items-center justify-between">
					<span class="text-sm font-medium" id="publish-status-label">发布状态</span>
					<button
						type="button"
						role="switch"
						aria-checked={isPublished}
						aria-labelledby="publish-status-label"
						class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors {isPublished
							? 'bg-primary'
							: 'bg-muted'}"
						onclick={() => (isPublished = !isPublished)}
					>
						<span
							class="inline-block size-4 rounded-full bg-white shadow-sm transition-transform {isPublished
								? 'translate-x-4.5'
								: 'translate-x-0.5'}"
						></span>
					</button>
				</div>

				<!-- Save as draft: forces isPublished off before submitting the form -->
				<Button
					type="button"
					variant="outline"
					class="w-full"
					onclick={async () => {
						isPublished = false;
						await tick();
						const formEl = document.getElementById('post-form');
						if (formEl instanceof HTMLFormElement) formEl.requestSubmit();
					}}
				>
					<IconDeviceFloppy class="size-4" />
					保存为草稿
				</Button>
			</div>
		</Sheet.Content>
	</Sheet.Portal>
</Sheet.Root>

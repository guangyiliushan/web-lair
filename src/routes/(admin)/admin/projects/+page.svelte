<script lang="ts">
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconFileImport from '@tabler/icons-svelte-runes/icons/file-import';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';

	interface Project {
		id: string;
		name: string;
		description: string;
		content: string;
		avatarUrl: string;
		projectUrl: string;
		previewUrl: string;
		docsUrl: string;
		imageUrls: string;
		createdAt: string;
	}

	const projects: Project[] = [
		{
			id: '1',
			name: 'asdf',
			description: 'asdf',
			content: 'asdf',
			avatarUrl: '',
			projectUrl: '',
			previewUrl: '',
			docsUrl: '',
			imageUrls: '',
			createdAt: '1小时前'
		}
	];

	let selectedProjectId = $state<string | null>(page.url.searchParams.get('id'));
	let creatingNew = $state(false);

	function selectProject(id: string) {
		selectedProjectId = id;
		creatingNew = false;
		goto(`?id=${id}`, { replaceState: true });
	}

	function backToProjectList() {
		selectedProjectId = null;
		creatingNew = false;
		goto('.', { replaceState: true });
	}

	const selectedProject = $derived(projects.find((p) => p.id === selectedProjectId) ?? null);

	/** Extract first 1-2 characters from project name for avatar display */
	function avatarText(name: string): string {
		return name.slice(0, 1).toUpperCase();
	}

	/** New project form state */
	let formName = $state('');
	let formAvatarUrl = $state('');
	let formDescription = $state('');
	let formProjectUrl = $state('');
	let formPreviewUrl = $state('');
	let formDocsUrl = $state('');
	let formImageUrls = $state('');
	let formContent = $state('');

	function resetForm() {
		formName = '';
		formAvatarUrl = '';
		formDescription = '';
		formProjectUrl = '';
		formPreviewUrl = '';
		formDocsUrl = '';
		formImageUrls = '';
		formContent = '';
	}

	function openNewProject() {
		resetForm();
		creatingNew = true;
		selectedProjectId = null;
	}

	function closeForm() {
		creatingNew = false;
		resetForm();
	}
</script>

<svelte:head>
	<title>项目管理 - Lair Admin</title>
</svelte:head>

<!-- Mobile: flat layout -->
<div class="flex min-h-0 flex-1 flex-col sm:hidden">
	{#if selectedProject && !creatingNew}
		{@const project = selectedProject}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					class="size-8"
					onclick={backToProjectList}
					aria-label="返回列表"
				>
					<IconArrowLeft data-icon="inline-start" />
				</Button>
				<h2 class="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
					<span
						class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase ring-1 ring-border"
					>
						{avatarText(project.name)}
					</span>
					<span class="truncate">{project.name}</span>
				</h2>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<Button variant="outline" size="sm">
					<IconPencil data-icon="inline-start" />编辑
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
				>
					<IconTrash data-icon="inline-start" />删除
				</Button>
			</div>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto grid max-w-3xl gap-6 p-6">
				<div class="flex items-start gap-4">
					<span
						class="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-xl font-semibold uppercase ring-1 ring-border"
					>
						{avatarText(project.name)}
					</span>
					<div class="min-w-0 flex-1">
						<h3 class="text-lg font-semibold">{project.name}</h3>
						<p class="mt-1 text-sm leading-6 text-muted-foreground">{project.description}</p>
						<div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
							<time>创建于 {project.createdAt}</time>
						</div>
					</div>
				</div>
				{#if project.content}
					<section class="border-t pt-5">
						<h4 class="mb-3 text-sm font-medium">项目介绍</h4>
						<div class="prose max-w-none text-sm">
							<p>{project.content}</p>
						</div>
					</section>
				{/if}
			</div>
		</div>
	{:else}
		<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
			<div class="flex min-w-0 items-center gap-2">
				<IconFolder class="size-4 shrink-0 text-muted-foreground" />
				<h2 class="truncate text-sm font-semibold">项目列表</h2>
				<span class="text-xs text-muted-foreground tabular-nums">{projects.length} 个</span>
			</div>
			<Button size="sm" variant="outline" onclick={openNewProject}>
				<IconPlus data-icon="inline-start" />新建项目
			</Button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if projects.length === 0}
				<div class="flex flex-col items-center gap-1 py-12">
					<p class="text-sm text-muted-foreground">暂无项目</p>
				</div>
			{:else}
				{#each projects as project (project.id)}
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50',
							selectedProjectId === project.id && !creatingNew && 'bg-muted/50'
						)}
						onclick={() => selectProject(project.id)}
					>
						<span
							class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase ring-1 ring-border"
						>
							{avatarText(project.name)}
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-2">
								<span class="truncate text-sm font-medium">{project.name}</span>
							</span>
							<span class="mt-0.5 block truncate text-xs text-muted-foreground"
								>{project.description}</span
							>
							<time class="mt-1 block text-xs text-muted-foreground/70">{project.createdAt}</time>
						</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Desktop: MasterDetail -->
<div class="hidden min-h-0 flex-1 sm:flex">
	<MasterDetail.Root class="h-[calc(100vh-10rem)]">
		<!-- ===== 左侧：项目列表 ===== -->
		<MasterDetail.Pane side="master" class="w-80 shrink-0">
			<MasterDetail.Header icon={IconFolder} title="项目列表" count={projects.length}>
				<Button size="sm" variant="outline" onclick={openNewProject}>
					<IconPlus class="size-3.5" />
					新建项目
				</Button>
			</MasterDetail.Header>

			<MasterDetail.List>
				{#if projects.length === 0}
					<div class="flex flex-col items-center gap-1 py-12">
						<p class="text-sm text-muted-foreground">暂无项目</p>
					</div>
				{:else}
					{#each projects as project (project.id)}
						<MasterDetail.Item
							selected={selectedProjectId === project.id && !creatingNew}
							onclick={() => selectProject(project.id)}
						>
							<span
								class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase ring-1 ring-border"
							>
								{avatarText(project.name)}
							</span>
							<span class="min-w-0 flex-1">
								<span class="flex items-center gap-2">
									<span class="truncate text-sm font-medium">{project.name}</span>
								</span>
								<span class="mt-0.5 block truncate text-xs text-muted-foreground"
									>{project.description}</span
								>
								<time class="mt-1 block text-xs text-muted-foreground/70">{project.createdAt}</time>
							</span>
						</MasterDetail.Item>
					{/each}
				{/if}
			</MasterDetail.List>
		</MasterDetail.Pane>

		<!-- ===== 右侧：详情 / 新建表单 ===== -->
		<MasterDetail.Pane side="detail">
			{#if creatingNew}
				<!-- 新建项目表单 -->
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<div class="flex min-w-0 items-center gap-2">
						<Button variant="outline" size="sm" class="gap-1 lg:hidden" onclick={closeForm}>
							<IconArrowLeft class="size-4" />
							返回
						</Button>
						<h2 class="text-lg font-semibold">新建项目</h2>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" class="gap-1">
							<IconFileImport class="size-4" />
							从 GitHub 获取
						</Button>
						<Button variant="outline" size="sm" class="gap-1" onclick={closeForm}>
							<IconX class="size-4" />
							取消
						</Button>
						<Button size="sm" disabled={!formName.trim() || !formContent.trim()}>创建</Button>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-auto">
					<form class="mx-auto grid max-w-3xl gap-4 p-6">
						<!-- GitHub import -->
						<section class="grid gap-3 rounded border bg-muted/50 p-3">
							<div class="flex items-center gap-2 text-sm font-medium">
								<IconFileImport class="size-4" />
								从 GitHub 仓库导入
							</div>
							<div class="flex flex-col gap-2 sm:flex-row">
								<Input class="flex-1" placeholder="https://github.com/owner/repo" />
								<Button size="sm">
									<IconFileImport class="size-4" />
									获取
								</Button>
							</div>
						</section>

						<div class="grid gap-4 md:grid-cols-2">
							<div class="grid gap-1.5">
								<label for="proj-name" class="text-sm font-medium">
									项目名称<span class="text-destructive"> *</span>
								</label>
								<Input id="proj-name" required bind:value={formName} />
							</div>
							<div class="grid gap-1.5">
								<label for="proj-avatar" class="text-sm font-medium">头像 URL</label>
								<Input id="proj-avatar" bind:value={formAvatarUrl} />
							</div>
						</div>

						<div class="grid gap-1.5">
							<label for="proj-desc" class="text-sm font-medium">描述</label>
							<Input id="proj-desc" bind:value={formDescription} />
						</div>

						<div class="grid gap-4 md:grid-cols-3">
							<div class="grid gap-1.5">
								<label for="proj-url" class="text-sm font-medium">项目 URL</label>
								<Input id="proj-url" bind:value={formProjectUrl} />
							</div>
							<div class="grid gap-1.5">
								<label for="proj-preview" class="text-sm font-medium">预览 URL</label>
								<Input id="proj-preview" bind:value={formPreviewUrl} />
							</div>
							<div class="grid gap-1.5">
								<label for="proj-docs" class="text-sm font-medium">文档 URL</label>
								<Input id="proj-docs" bind:value={formDocsUrl} />
							</div>
						</div>

						<div class="grid gap-1.5">
							<label for="proj-images" class="text-sm font-medium">图片 URL</label>
							<Textarea
								id="proj-images"
								class="min-h-20"
								placeholder="一行一个图片 URL"
								bind:value={formImageUrls}
							/>
						</div>

						<div class="grid gap-1.5">
							<label for="proj-content" class="text-sm font-medium">
								内容<span class="text-destructive"> *</span>
							</label>
							<Textarea
								id="proj-content"
								class="min-h-72 font-mono"
								required
								bind:value={formContent}
							/>
						</div>
					</form>
				</div>
			{:else if selectedProject}
				{@const project = selectedProject}
				<!-- 项目详情 -->
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<div class="flex min-w-0 items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							class="gap-1 lg:hidden"
							onclick={() => (selectedProjectId = null)}
						>
							<IconArrowLeft class="size-4" />
							返回
						</Button>
						<h2 class="inline-flex min-w-0 items-center gap-2 text-lg font-semibold">
							<span
								class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase ring-1 ring-border"
							>
								{avatarText(project.name)}
							</span>
							<span class="truncate">{project.name}</span>
						</h2>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" class="gap-1" onclick={closeForm}>
							<IconArrowLeft class="size-4" />
							关闭
						</Button>
						<Button variant="outline" size="sm" class="gap-1">
							<IconPencil class="size-4" />
							编辑
						</Button>
						<Button
							variant="outline"
							size="sm"
							class="gap-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
						>
							<IconTrash class="size-4" />
							删除
						</Button>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-auto">
					<div class="mx-auto grid max-w-3xl gap-6 p-6">
						<div class="flex items-start gap-4">
							<span
								class="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-xl font-semibold uppercase ring-1 ring-border"
							>
								{avatarText(project.name)}
							</span>
							<div class="min-w-0 flex-1">
								<h3 class="text-lg font-semibold">{project.name}</h3>
								<p class="mt-1 text-sm leading-6 text-muted-foreground">{project.description}</p>
								<div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
									<time>创建于 {project.createdAt}</time>
								</div>
							</div>
						</div>

						<div class="flex flex-wrap gap-2 border-t pt-5"></div>

						{#if project.content}
							<section class="border-t pt-5">
								<h4 class="mb-3 text-sm font-medium">项目介绍</h4>
								<div class="prose max-w-none text-sm">
									<p>{project.content}</p>
								</div>
							</section>
						{/if}
					</div>
				</div>
			{:else}
				<!-- 未选择时的占位 -->
				<div class="flex flex-1 items-center justify-center">
					<div class="flex flex-col items-center gap-2 text-center">
						<IconFolder class="size-10 text-muted-foreground/40" />
						<h3 class="text-lg font-semibold tracking-tight">选择一个项目</h3>
						<p class="text-sm text-muted-foreground">从左侧列表中选择项目以查看详情</p>
					</div>
				</div>
			{/if}
		</MasterDetail.Pane>
	</MasterDetail.Root>
</div>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Command from '$lib/components/ui/command';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { cn } from '$lib/utils';
	import { SvelteSet } from 'svelte/reactivity';
	import type { SubmitFunction } from '@sveltejs/kit';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

	let formEl = $state<HTMLFormElement | null>(null);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let confirmOpen = $state(false);
	let moveOpen = $state(false);
	let pickOpen = $state(false);
	let pickQuery = $state('');
	let moveTarget = $state('');
	let statusFilter = $state('all');
	let workspaceQuery = $state('');
	// SvelteSet is the project's reactive collection; mutating it is enough.
	let selected = new SvelteSet<string>();

	/**
	 * Edits autosave after a short idle (design D3). SvelteKit's `snapshot()`
	 * helper is SvelteKit 3-only and the SK2 equivalent does not capture on
	 * shallow navigations, and `beforeNavigate` cannot await a confirmation —
	 * so debounced silent save is the only protection that cannot lose work.
	 */
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => formEl?.requestSubmit(), 400);
	}

	function slugify(name: string) {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function onNameInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const slug = formEl?.elements.namedItem('slug') as HTMLInputElement | null;
		// Only rewrite the slug while it still tracks the name, so a hand-set
		// slug is not clobbered on every keystroke.
		if (slug && (!slug.dataset.touched || slug.value === '')) slug.value = slugify(input.value);
		scheduleSave();
	}

	function onSlugInput(e: Event) {
		(e.currentTarget as HTMLInputElement).dataset.touched = 'true';
		scheduleSave();
	}

	const headerActions = useAdminHeaderActionRegistry();
	$effect(() => headerActions?.register('categories:delete', () => (confirmOpen = true)));

	// The source locale is locked after creation, so it is rendered as a static
	// marker (no fake select) and its field is the plain `name` input.
	const translationFields = $derived(
		[
			{ key: 'en', label: m.admin_taxonomy_name_en() },
			{ key: 'zh-cn', label: m.admin_taxonomy_name_zh() },
			{ key: 'ja', label: m.admin_taxonomy_name_ja() }
		].filter((field) => field.key !== data.category.sourceLang)
	);

	function translationValue(key: string): string {
		return data.category.nameI18n[key as 'en' | 'zh-cn' | 'ja'] ?? '';
	}

	/** Targets for "move to…" — every category except the one we are in. */
	const moveTargets = $derived(
		data.categories.filter((c) => c.id !== data.category.id && !c.isDefault)
	);

	const visiblePosts = $derived(
		data.related.filter((p) => {
			if (statusFilter !== 'all' && p.status !== statusFilter) return false;
			const q = workspaceQuery.trim().toLowerCase();
			if (q === '') return true;
			return p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
		})
	);

	/** Posts not already filed here, for the "pull in" picker. */
	const pickable = $derived(
		data.pickable.filter((p) => {
			if (pickQuery.trim() === '') return true;
			const q = pickQuery.trim().toLowerCase();
			return p.title.toLowerCase().includes(q) || p.categoryName.toLowerCase().includes(q);
		})
	);

	function toggle(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	function toggleAll() {
		if (selected.size === visiblePosts.length) selected.clear();
		else for (const post of visiblePosts) selected.add(post.id);
	}

	/** Where the post editor should send us back to. */
	function editHref(id: string) {
		return `/admin/posts/edit?id=${id}&returnTo=/admin/posts/categories/${data.category.id}`;
	}

	const afterDelete: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false, invalidateAll: false });
			if (result.type === 'success') await goto('/admin/posts/categories', { replaceState: true });
		};
	};

	/** Move is a no-redirect mutation: refresh and keep the selection cleared. */
	const afterMove: SubmitFunction = () => {
		return async ({ update }) => {
			selected.clear();
			moveOpen = false;
			pickOpen = false;
			moveTarget = '';
			await update();
		};
	};
</script>

<div class="@container/detail flex min-h-0 flex-1 flex-col">
	<!-- Panel heading: focus lands here on open (a11y contract). -->
	<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
		<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
			{data.category.name}
		</h1>
		{#if data.category.isDefault}
			<Badge variant="secondary">{m.admin_categories_default_badge()}</Badge>
		{/if}
		<span class="shrink-0 font-mono text-xs text-muted-foreground">{data.category.slug}</span>
		<Separator orientation="vertical" class="h-4" />
		<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
			{m.admin_categories_post_count({ count: data.related.length })}
		</span>
	</div>

	<!-- Identity form: two columns when the pane allows it. -->
	<form
		bind:this={formEl}
		method="POST"
		action="?/update"
		use:enhance
		class="shrink-0 border-b px-4 py-3"
	>
		<Field.FieldGroup
			class="gap-x-4 gap-y-2.5 @min-[32rem]/detail:grid @min-[32rem]/detail:grid-cols-2"
		>
			<Field.Field>
				<Field.FieldLabel for="cat-name" class="text-[11px]">
					{m.admin_categories_name()}
				</Field.FieldLabel>
				<Input
					id="cat-name"
					name="name"
					class="h-8"
					value={data.category.name}
					oninput={onNameInput}
					required
				/>
			</Field.Field>

			<Field.Field>
				<Field.FieldLabel for="cat-slug" class="text-[11px]">Slug</Field.FieldLabel>
				<Input
					id="cat-slug"
					name="slug"
					class="h-8 font-mono"
					value={data.category.slug}
					oninput={onSlugInput}
					placeholder={m.admin_categories_slug_hint()}
					required
				/>
			</Field.Field>

			<Field.Field class="@min-[32rem]/detail:col-span-2">
				<Field.FieldLabel for="cat-desc" class="text-[11px]">
					{m.admin_categories_description()}
				</Field.FieldLabel>
				<Textarea
					id="cat-desc"
					name="description"
					class="min-h-16 text-sm"
					value={data.category.description ?? ''}
					oninput={scheduleSave}
				/>
			</Field.Field>

			<div class="flex items-center gap-2 @min-[32rem]/detail:col-span-2">
				<Separator class="flex-1" />
				<span class="shrink-0 text-[11px] text-muted-foreground">
					{m.admin_taxonomy_source_lang()}: {data.category.sourceLang}
				</span>
				<Separator class="flex-1" />
			</div>

			{#each translationFields as field (field.key)}
				<Field.Field>
					<Field.FieldLabel for={`cat-name-${field.key}`} class="text-[11px]">
						{field.label}
					</Field.FieldLabel>
					<Input
						id={`cat-name-${field.key}`}
						name={`name_${field.key}`}
						class="h-8"
						value={translationValue(field.key)}
						oninput={scheduleSave}
					/>
				</Field.Field>
			{/each}

			{#if form?.error}
				<Field.FieldError class="@min-[32rem]/detail:col-span-2">{form.error}</Field.FieldError>
			{/if}
		</Field.FieldGroup>
	</form>

	<!-- Record workspace: owns its own scroll, so the form above stays put. -->
	<section class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
			<h2 class="shrink-0 text-sm font-medium">{m.admin_categories_workspace_title()}</h2>
			<!-- sr-only Label, not aria-label: real <label for> association, no layout cost. -->
			<Label class="sr-only" for="category-posts-search">
				{m.admin_categories_search_posts()}
			</Label>
			<Input
				id="category-posts-search"
				type="search"
				class="h-8 min-w-0 flex-1 border-transparent bg-transparent"
				placeholder={m.admin_categories_search_posts()}
				bind:value={workspaceQuery}
			/>
			<Button size="sm" variant="outline" onclick={() => (pickOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_categories_move_in()}
			</Button>
		</div>

		<div class="flex h-10 shrink-0 items-center gap-2 border-b px-4">
			<ToggleGroup.Root
				type="single"
				bind:value={statusFilter}
				variant="outline"
				size="sm"
				class="gap-1"
			>
				<ToggleGroup.Item value="all">{m.admin_common_all()}</ToggleGroup.Item>
				<ToggleGroup.Item value="draft">{m.admin_posts_status_draft()}</ToggleGroup.Item>
				<ToggleGroup.Item value="published">{m.admin_posts_status_published()}</ToggleGroup.Item>
			</ToggleGroup.Root>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if visiblePosts.length === 0}
				<p class="px-4 py-8 text-center text-sm text-muted-foreground">
					{workspaceQuery.trim()
						? m.admin_common_no_search_results()
						: m.admin_categories_no_posts()}
				</p>
			{:else}
				<ul class="flex flex-col">
					<li class="flex h-8 items-center gap-2 border-b px-4 text-[11px] text-muted-foreground">
						<Checkbox
							class="size-3.5"
							checked={selected.size > 0 && selected.size === visiblePosts.length}
							onCheckedChange={toggleAll}
							aria-label={m.admin_categories_selected({ count: visiblePosts.length })}
						/>
						<span class="flex-1">{m.admin_categories_workspace_title()}</span>
						<span class="w-14 shrink-0">lang</span>
						<span class="w-20 shrink-0">status</span>
						<span class="w-16 shrink-0"></span>
					</li>
					{#each visiblePosts as post (post.id)}
						<li
							class={cn(
								'flex h-9 items-center gap-2 border-b px-4',
								'[@media(hover:hover)]:hover:bg-muted/40'
							)}
						>
							<Checkbox
								class="size-3.5"
								checked={selected.has(post.id)}
								onCheckedChange={() => toggle(post.id)}
								aria-label={post.title}
							/>
							<a href={editHref(post.id)} class="min-w-0 flex-1 truncate text-sm hover:underline">
								{post.title}
							</a>
							<span class="w-14 shrink-0 text-xs text-muted-foreground">{post.lang}</span>
							<span class="w-20 shrink-0 text-xs text-muted-foreground">{post.status}</span>
							<span class="flex w-16 shrink-0 items-center justify-end gap-0.5">
								<Button variant="ghost" size="icon" class="size-7" href={editHref(post.id)}>
									<IconPencil data-icon="inline-start" />
									<span class="sr-only">{m.admin_categories_edit_post()}</span>
								</Button>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button variant="ghost" size="icon" class="size-7" {...props}>
												<IconDots data-icon="inline-start" />
												<span class="sr-only">{m.admin_common_more()}</span>
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Group>
											<DropdownMenu.Item onSelect={() => toggle(post.id)}>
												{m.admin_categories_move_out()}
											</DropdownMenu.Item>
											<DropdownMenu.Item onSelect={() => goto(editHref(post.id))}>
												{m.admin_categories_edit_post()}
											</DropdownMenu.Item>
										</DropdownMenu.Group>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if selected.size > 0}
			<div class="flex h-11 shrink-0 items-center gap-2 border-t bg-muted/30 px-4">
				<span class="text-xs text-muted-foreground tabular-nums">
					{m.admin_categories_selected({ count: selected.size })}
				</span>
				<div class="flex-1"></div>
				<form method="POST" action="?/move" use:enhance={afterMove} class="contents">
					{#each [...selected] as id (id)}
						<input type="hidden" name="postId" value={id} />
					{/each}
					<input type="hidden" name="to" value="" />
					<Button type="submit" size="sm" variant="ghost" disabled={data.category.isDefault}>
						{m.admin_categories_move_out()}
					</Button>
				</form>
				<Button size="sm" variant="outline" onclick={() => (moveOpen = true)}>
					{m.admin_categories_move_to()}
				</Button>
				<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
					{m.admin_categories_clear_selection()}
				</Button>
			</div>
		{/if}
	</section>
</div>

<!-- Move the current selection to another category. -->
<Dialog.Root bind:open={moveOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{m.admin_categories_move_to()}</Dialog.Title>
		</Dialog.Header>
		<form
			method="POST"
			action="?/move"
			use:enhance={afterMove}
			class="flex flex-col gap-3 px-6 pb-4"
		>
			{#each [...selected] as id (id)}
				<input type="hidden" name="postId" value={id} />
			{/each}
			<input type="hidden" name="to" value={moveTarget} />
			{#if moveTargets.length === 0}
				<p class="text-sm text-muted-foreground">{m.admin_categories_no_move_target()}</p>
			{:else}
				<RadioGroup.Root bind:value={moveTarget} class="gap-1.5">
					{#each moveTargets as target (target.id)}
						<label
							class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm [@media(hover:hover)]:hover:bg-muted/50"
						>
							<RadioGroup.Item value={target.id} />
							<span class="min-w-0 flex-1 truncate">{target.name}</span>
							<span class="shrink-0 font-mono text-xs text-muted-foreground">{target.slug}</span>
						</label>
					{/each}
				</RadioGroup.Root>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (moveOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit" disabled={moveTargets.length === 0 || moveTarget === ''}>
					{m.admin_categories_move_to()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Pull posts in from elsewhere. -->
<Dialog.Root bind:open={pickOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.admin_categories_move_in()}</Dialog.Title>
		</Dialog.Header>
		<Command.Root class="max-h-80">
			<Command.Input placeholder={m.admin_categories_search_posts()} bind:value={pickQuery} />
			<Command.List>
				<Command.Empty>{m.admin_categories_no_pickable()}</Command.Empty>
				<Command.Group>
					{#each pickable as post (post.id)}
						<Command.Item value={post.id} onSelect={() => toggle(post.id)}>
							<Checkbox
								class="size-3.5"
								checked={selected.has(post.id)}
								tabindex={-1}
								aria-hidden="true"
							/>
							<span class="min-w-0 flex-1 truncate">{post.title}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{post.categoryName}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
		<form
			method="POST"
			action="?/move"
			use:enhance={afterMove}
			class="flex flex-col gap-2 px-6 pb-4"
		>
			{#each [...selected] as id (id)}
				<input type="hidden" name="postId" value={id} />
			{/each}
			<input type="hidden" name="to" value={data.category.id} />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (pickOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit" disabled={selected.size === 0}>
					{m.admin_categories_move_in()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_categories_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_categories_delete_desc({ name: data.category.name })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<!-- Cancel is never the default (Apple HIG, Alerts). -->
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form method="POST" action="?/delete" use:enhance={afterDelete}>
				<Button type="submit" variant="destructive">
					<IconTrash data-icon="inline-start" />
					{m.admin_common_delete()}
				</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

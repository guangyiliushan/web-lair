<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Separator } from '$lib/components/ui/separator';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Command from '$lib/components/ui/command';
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
	let pickOpen = $state(false);
	let pickQuery = $state('');
	// SvelteSet is the project's reactive collection; mutating it is enough.
	let selected = new SvelteSet<string>();

	/**
	 * Edits autosave after a short idle. SvelteKit's `snapshot()` helper is
	 * SvelteKit 3-only and the SK2 equivalent does not capture on shallow
	 * navigations, and `beforeNavigate` cannot await a confirmation — so
	 * debounced silent save is the only protection that cannot lose work.
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
	$effect(() => headerActions?.register('tags:delete', () => (confirmOpen = true)));

	const pickable = $derived(
		data.pickable.filter((p) => {
			if (pickQuery.trim() === '') return true;
			return p.title.toLowerCase().includes(pickQuery.trim().toLowerCase());
		})
	);

	function toggle(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	function toggleAll() {
		if (selected.size === data.related.length) selected.clear();
		else for (const post of data.related) selected.add(post.id);
	}

	/** Where the post editor should send us back to. */
	function editHref(id: string) {
		return `/admin/posts/edit?id=${id}&returnTo=/admin/posts/tags/${data.tag.id}`;
	}

	const afterDelete: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false, invalidateAll: false });
			if (result.type === 'success') await goto('/admin/posts/tags', { replaceState: true });
		};
	};

	const afterLink: SubmitFunction = () => {
		return async ({ update }) => {
			selected.clear();
			pickOpen = false;
			await update();
		};
	};
</script>

<div class="@container/detail flex min-h-0 flex-1 flex-col">
	<!-- Panel heading: focus lands here on open (a11y contract). -->
	<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
		<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
			{data.tag.name}
		</h1>
		<span class="shrink-0 font-mono text-xs text-muted-foreground">{data.tag.slug}</span>
		<Separator orientation="vertical" class="h-4" />
		<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
			{m.admin_tags_usage_count({ count: data.related.length })}
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
				<Field.FieldLabel for="tag-name" class="text-[11px]">{m.admin_tags_name()}</Field.FieldLabel
				>
				<Input
					id="tag-name"
					name="name"
					class="h-8"
					value={data.tag.name}
					oninput={onNameInput}
					required
				/>
			</Field.Field>

			<Field.Field>
				<Field.FieldLabel for="tag-slug" class="text-[11px]">Slug</Field.FieldLabel>
				<Input
					id="tag-slug"
					name="slug"
					class="h-8 font-mono"
					value={data.tag.slug}
					oninput={onSlugInput}
					placeholder={m.admin_categories_slug_hint()}
					required
				/>
			</Field.Field>

			<Field.Field class="@min-[32rem]/detail:col-span-2">
				<Field.FieldLabel for="tag-desc" class="text-[11px]">
					{m.admin_categories_description()}
				</Field.FieldLabel>
				<Textarea
					id="tag-desc"
					name="description"
					class="min-h-16 text-sm"
					value={data.tag.description ?? ''}
					oninput={scheduleSave}
				/>
			</Field.Field>

			{#if form?.error}
				<Field.FieldError class="@min-[32rem]/detail:col-span-2">{form.error}</Field.FieldError>
			{/if}
		</Field.FieldGroup>
	</form>

	<!-- Tagged posts: owns its own scroll, so the form above stays put. -->
	<section class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
			<h2 class="shrink-0 text-sm font-medium">{m.admin_tags_workspace_title()}</h2>
			<Input
				type="search"
				class="h-8 min-w-0 flex-1 border-transparent bg-transparent"
				placeholder={m.admin_categories_search_posts()}
			/>
			<Button size="sm" variant="outline" onclick={() => (pickOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_tags_attach()}
			</Button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.related.length === 0}
				<p class="px-4 py-8 text-center text-sm text-muted-foreground">{m.admin_tags_no_posts()}</p>
			{:else}
				<ul class="flex flex-col">
					<li class="flex h-8 items-center gap-2 border-b px-4 text-[11px] text-muted-foreground">
						<Checkbox
							class="size-3.5"
							checked={selected.size > 0 && selected.size === data.related.length}
							onCheckedChange={toggleAll}
							aria-label={m.admin_categories_selected({ count: data.related.length })}
						/>
						<span class="flex-1">{m.admin_tags_workspace_title()}</span>
						<span class="w-14 shrink-0">lang</span>
						<span class="w-20 shrink-0">status</span>
						<span class="w-16 shrink-0"></span>
					</li>
					{#each data.related as post (post.id)}
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
												{m.admin_tags_detach()}
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
				<form method="POST" action="?/link" use:enhance={afterLink} class="contents">
					{#each [...selected] as id (id)}
						<input type="hidden" name="postId" value={id} />
					{/each}
					<input type="hidden" name="op" value="detach" />
					<Button type="submit" size="sm" variant="ghost">
						{m.admin_tags_detach()}
					</Button>
				</form>
				<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
					{m.admin_categories_clear_selection()}
				</Button>
			</div>
		{/if}
	</section>
</div>

<!-- Attach the tag to posts that do not carry it yet. -->
<Dialog.Root bind:open={pickOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.admin_tags_attach()}</Dialog.Title>
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
							<span class="shrink-0 text-xs text-muted-foreground">{post.status}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
		<form
			method="POST"
			action="?/link"
			use:enhance={afterLink}
			class="flex flex-col gap-2 px-6 pb-4"
		>
			{#each [...selected] as id (id)}
				<input type="hidden" name="postId" value={id} />
			{/each}
			<input type="hidden" name="op" value="attach" />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (pickOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit" disabled={selected.size === 0}>{m.admin_tags_attach()}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_tags_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_tags_delete_desc({ name: data.tag.name })}
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

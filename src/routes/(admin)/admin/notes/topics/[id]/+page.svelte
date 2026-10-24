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
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Command from '$lib/components/ui/command';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
	import { cn } from '$lib/utils';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { SubmitFunction } from '@sveltejs/kit';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';

	let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

	let formEl = $state<HTMLFormElement | null>(null);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let confirmOpen = $state(false);
	let pickOpen = $state(false);
	let pickQuery = $state('');
	// The icon is a form field seeded once from the loaded record; later data
	// refreshes must not clobber what the owner is typing (same reason the AI
	// settings page seeds its local state with `untrack`).
	let iconValue = $state(untrack(() => data.topic.icon ?? ''));
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
	$effect(() => headerActions?.register('topics:delete', () => (confirmOpen = true)));

	// The source locale is locked after creation, so it is rendered as a static
	// marker (no fake select) and its field is the plain `name` input.
	const translationFields = $derived(
		[
			{ key: 'en', label: m.admin_taxonomy_name_en() },
			{ key: 'zh-cn', label: m.admin_taxonomy_name_zh() },
			{ key: 'ja', label: m.admin_taxonomy_name_ja() }
		].filter((field) => field.key !== data.topic.sourceLang)
	);

	function translationValue(field: 'name' | 'description', key: string): string {
		const map = field === 'name' ? data.topic.nameI18n : data.topic.descriptionI18n;
		return map[key as 'en' | 'zh-cn' | 'ja'] ?? '';
	}

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
		else for (const note of data.related) selected.add(note.id);
	}

	/** Where the note editor should send us back to. */
	function editHref(id: string) {
		return `/admin/notes/edit?id=${id}&returnTo=/admin/notes/topics/${data.topic.id}`;
	}

	const afterDelete: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false, invalidateAll: false });
			if (result.type === 'success') await goto('/admin/notes/topics', { replaceState: true });
		};
	};

	const afterLink: SubmitFunction = () => {
		return async ({ update }) => {
			selected.clear();
			pickOpen = false;
			await update();
		};
	};

	/** ▲/▼ is a page-level mutation: submit and keep the current selection. */
	function submitOrder(direction: 'up' | 'down') {
		const fd = new FormData(formEl ?? undefined);
		fd.set('direction', direction);
		fetch('?/move', { method: 'POST', body: fd }).then(() => goto('.', { invalidateAll: true }));
	}
</script>

<div class="@container/detail flex min-h-0 flex-1 flex-col">
	<!-- Panel heading: focus lands here on open (a11y contract). -->
	<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
		<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
			{data.topic.name}
		</h1>
		<span class="shrink-0 font-mono text-xs text-muted-foreground">{data.topic.slug}</span>
		<Separator orientation="vertical" class="h-4" />
		<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
			{m.admin_notes_topics_note_count({ count: data.related.length })}
		</span>
		<Separator orientation="vertical" class="h-4" />
		<Button variant="ghost" size="icon" class="size-7" onclick={() => submitOrder('up')}>
			<IconArrowUp data-icon="inline-start" />
			<span class="sr-only">{m.admin_notes_topics_move_up()}</span>
		</Button>
		<Button variant="ghost" size="icon" class="size-7" onclick={() => submitOrder('down')}>
			<IconArrowDown data-icon="inline-start" />
			<span class="sr-only">{m.admin_notes_topics_move_down()}</span>
		</Button>
	</div>

	<!-- Identity form: two columns when the pane allows it. -->
	<form
		bind:this={formEl}
		method="POST"
		action="?/update"
		use:enhance
		class="shrink-0 border-b px-4 py-3"
	>
		<input type="hidden" name="icon" value={iconValue} />
		<Field.FieldGroup
			class="gap-x-4 gap-y-2.5 @min-[32rem]/detail:grid @min-[32rem]/detail:grid-cols-2"
		>
			<Field.Field>
				<Field.FieldLabel for="topic-name" class="text-[11px]">
					{m.admin_notes_topics_name()}
				</Field.FieldLabel>
				<Input
					id="topic-name"
					name="name"
					class="h-8"
					value={data.topic.name}
					oninput={onNameInput}
					required
				/>
			</Field.Field>

			<Field.Field>
				<Field.FieldLabel for="topic-slug" class="text-[11px]">Slug</Field.FieldLabel>
				<Input
					id="topic-slug"
					name="slug"
					class="h-8 font-mono"
					value={data.topic.slug}
					oninput={onSlugInput}
					placeholder={m.admin_categories_slug_hint()}
					required
				/>
			</Field.Field>

			<Field.Field>
				<Field.FieldLabel for="topic-icon" class="text-[11px]">
					{m.admin_notes_topics_icon()}
				</Field.FieldLabel>
				<Select.Root type="single" bind:value={iconValue}>
					<Select.Trigger class="h-8 w-full" id="topic-icon">
						{iconValue === '' ? m.admin_notes_topics_icon_none() : iconValue}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							<Select.Item value="">{m.admin_notes_topics_icon_none()}</Select.Item>
							{#each NAV_ICON_NAMES as name (name)}
								<Select.Item value={name}>{name}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</Field.Field>

			<Field.Field>
				<Field.FieldLabel for="topic-sort" class="text-[11px]">
					{m.admin_notes_topics_sort()}
				</Field.FieldLabel>
				<Input
					id="topic-sort"
					name="sortOrder"
					type="number"
					class="h-8"
					value={String(data.topic.sortOrder)}
					oninput={scheduleSave}
				/>
			</Field.Field>

			<Field.Field class="@min-[32rem]/detail:col-span-2">
				<Field.FieldLabel for="topic-desc" class="text-[11px]">
					{m.admin_categories_description()}
				</Field.FieldLabel>
				<Textarea
					id="topic-desc"
					name="description"
					class="min-h-16 text-sm"
					value={data.topic.description}
					oninput={scheduleSave}
				/>
			</Field.Field>

			<div class="flex items-center gap-2 @min-[32rem]/detail:col-span-2">
				<Separator class="flex-1" />
				<span class="shrink-0 text-[11px] text-muted-foreground">
					{m.admin_taxonomy_source_lang()}: {data.topic.sourceLang}
				</span>
				<Separator class="flex-1" />
			</div>

			{#each translationFields as field (field.key)}
				<Field.Field>
					<Field.FieldLabel for={`topic-name-${field.key}`} class="text-[11px]">
						{field.label}
					</Field.FieldLabel>
					<Input
						id={`topic-name-${field.key}`}
						name={`name_${field.key}`}
						class="h-8"
						value={translationValue('name', field.key)}
						oninput={scheduleSave}
					/>
				</Field.Field>
			{/each}

			{#each translationFields as field (field.key)}
				<Field.Field>
					<Field.FieldLabel for={`topic-desc-${field.key}`} class="text-[11px]">
						{m.admin_categories_description()} · {field.label}
					</Field.FieldLabel>
					<Input
						id={`topic-desc-${field.key}`}
						name={`description_${field.key}`}
						class="h-8"
						value={translationValue('description', field.key)}
						oninput={scheduleSave}
					/>
				</Field.Field>
			{/each}

			{#if form?.error}
				<Field.FieldError class="@min-[32rem]/detail:col-span-2">{form.error}</Field.FieldError>
			{/if}
		</Field.FieldGroup>
	</form>

	<!-- Notes workspace: owns its own scroll, so the form above stays put. -->
	<section class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
			<h2 class="shrink-0 text-sm font-medium">{m.admin_notes_topics_workspace_title()}</h2>
			<Input
				type="search"
				class="h-8 min-w-0 flex-1 border-transparent bg-transparent"
				placeholder={m.admin_categories_search_posts()}
			/>
			<Button size="sm" variant="outline" onclick={() => (pickOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_notes_topics_attach()}
			</Button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.related.length === 0}
				<p class="px-4 py-8 text-center text-sm text-muted-foreground">
					{m.admin_notes_topics_no_notes()}
				</p>
			{:else}
				<ul class="flex flex-col">
					<li class="flex h-8 items-center gap-2 border-b px-4 text-[11px] text-muted-foreground">
						<Checkbox
							class="size-3.5"
							checked={selected.size > 0 && selected.size === data.related.length}
							onCheckedChange={toggleAll}
							aria-label={m.admin_categories_selected({ count: data.related.length })}
						/>
						<span class="flex-1">{m.admin_notes_topics_workspace_title()}</span>
						<span class="w-14 shrink-0">lang</span>
						<span class="w-20 shrink-0">status</span>
						<span class="w-16 shrink-0"></span>
					</li>
					{#each data.related as note (note.id)}
						<li
							class={cn(
								'flex h-9 items-center gap-2 border-b px-4',
								'[@media(hover:hover)]:hover:bg-muted/40'
							)}
						>
							<Checkbox
								class="size-3.5"
								checked={selected.has(note.id)}
								onCheckedChange={() => toggle(note.id)}
								aria-label={note.title}
							/>
							<a href={editHref(note.id)} class="min-w-0 flex-1 truncate text-sm hover:underline">
								{note.title}
							</a>
							<span class="w-14 shrink-0 text-xs text-muted-foreground">{note.lang}</span>
							<span class="w-20 shrink-0 text-xs text-muted-foreground">{note.status}</span>
							<span class="flex w-16 shrink-0 items-center justify-end gap-0.5">
								<Button variant="ghost" size="icon" class="size-7" href={editHref(note.id)}>
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
											<DropdownMenu.Item onSelect={() => toggle(note.id)}>
												{m.admin_notes_topics_detach()}
											</DropdownMenu.Item>
											<DropdownMenu.Item onSelect={() => goto(editHref(note.id))}>
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
						<input type="hidden" name="noteId" value={id} />
					{/each}
					<input type="hidden" name="op" value="detach" />
					<Button type="submit" size="sm" variant="ghost">
						{m.admin_notes_topics_detach()}
					</Button>
				</form>
				<Button size="sm" variant="ghost" onclick={() => selected.clear()}>
					{m.admin_categories_clear_selection()}
				</Button>
			</div>
		{/if}
	</section>
</div>

<!-- File notes under this topic. -->
<Dialog.Root bind:open={pickOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.admin_notes_topics_attach()}</Dialog.Title>
		</Dialog.Header>
		<Command.Root class="max-h-80">
			<Command.Input placeholder={m.admin_categories_search_posts()} bind:value={pickQuery} />
			<Command.List>
				<Command.Empty>{m.admin_categories_no_pickable()}</Command.Empty>
				<Command.Group>
					{#each pickable as note (note.id)}
						<Command.Item value={note.id} onSelect={() => toggle(note.id)}>
							<Checkbox
								class="size-3.5"
								checked={selected.has(note.id)}
								tabindex={-1}
								aria-hidden="true"
							/>
							<span class="min-w-0 flex-1 truncate">{note.title}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{note.status}</span>
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
				<input type="hidden" name="noteId" value={id} />
			{/each}
			<input type="hidden" name="op" value="attach" />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (pickOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit" disabled={selected.size === 0}>
					{m.admin_notes_topics_attach()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_notes_topics_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_notes_topics_delete_desc({ name: data.topic.name })}
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

<script lang="ts">
	import type { LayoutData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	// Endonym + tag, e.g. `简体中文 (zh-cn)` — see the store for why locale
	// names are data, not catalog copy.
	import { localeOptionLabels as localeLabels } from '$lib/stores/locale.svelte';
	import { Empty } from '$lib/components/ui/empty';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let createOpen = $state(false);
	let createError = $state<string | null>(null);
	let sourceLang = $state('zh-cn');
	let createIcon = $state('');

	/** Selection lives in the route, so back/forward and deep links just work. */
	const selectedId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>{m.admin_notes_topics_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={selectedId !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.admin_notes_topics()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: data.topics.length })}
			</span>
			<Button size="sm" variant="ghost" onclick={() => (createOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_common_new()}
			</Button>
		</ListDetail.Toolbar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.topics.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_notes_topics_empty()}</p>
				</Empty>
			{:else}
				{#each data.topics as topic (topic.id)}
					<ListDetail.Row href="/admin/notes/topics/{topic.id}" selected={selectedId === topic.id}>
						<IconBulb class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-medium">{topic.name}</h3>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />
								{topic.slug}
							</p>
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{data.noteCounts[topic.id] ?? 0}
						</span>
					</ListDetail.Row>
				{/each}
			{/if}
		</div>
	</ListDetail.List>

	<ListDetail.Detail id={selectedId}>
		{@render children()}
	</ListDetail.Detail>
</ListDetail.Root>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.admin_notes_topics_create()}</Dialog.Title>
			<Dialog.Description>{m.admin_notes_topics_create_desc()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/admin/notes/topics?/create"
			use:enhance={() => {
				createError = null;
				return async ({ result, update }) => {
					// The dialog lives in the layout, which has no `form` prop, so the
					// failure payload is kept locally instead of read from page data.
					if (result.type === 'failure') {
						createError = (result.data?.error as string | undefined) ?? null;
					} else {
						createOpen = false;
					}
					await update();
				};
			}}
		>
			<Field.FieldGroup class="gap-3 px-6 pb-4">
				<!-- bits-ui Select does not submit with the form; carry the values. -->
				<input type="hidden" name="sourceLang" value={sourceLang} />
				<input type="hidden" name="icon" value={createIcon} />
				<Field.Field>
					<Field.FieldLabel for="new-topic-lang">
						{m.admin_taxonomy_source_lang()}
					</Field.FieldLabel>
					<Select.Root type="single" bind:value={sourceLang}>
						<Select.Trigger class="h-8 w-full" id="new-topic-lang">
							{localeLabels[sourceLang]}
						</Select.Trigger>
						<Select.Content>
							<Select.Group>
								{#each Object.entries(localeLabels) as [value, label] (value)}
									<Select.Item {value}>{label}</Select.Item>
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="new-topic-name">{m.admin_notes_topics_name()}</Field.FieldLabel>
					<Input id="new-topic-name" name="name" required />
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="new-topic-slug">Slug</Field.FieldLabel>
					<Input
						id="new-topic-slug"
						name="slug"
						class="font-mono"
						placeholder={m.admin_categories_slug_hint()}
						required
					/>
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="new-topic-icon">{m.admin_notes_topics_icon()}</Field.FieldLabel>
					<Select.Root type="single" bind:value={createIcon}>
						<Select.Trigger class="h-8 w-full" id="new-topic-icon">
							{createIcon === '' ? m.admin_notes_topics_icon_none() : createIcon}
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
					<Field.FieldLabel for="new-topic-sort">{m.admin_notes_topics_sort()}</Field.FieldLabel>
					<Input id="new-topic-sort" name="sortOrder" type="number" value="0" />
				</Field.Field>
			</Field.FieldGroup>
			{#if createError}
				<p role="alert" class="px-6 pb-2 text-sm text-destructive">{createError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (createOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit">{m.admin_common_create()}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts">
	import type { LayoutData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let createOpen = $state(false);
	let createError = $state<string | null>(null);

	/** Selection lives in the route, so back/forward and deep links just work. */
	const selectedId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>{m.admin_tags_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={selectedId !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.admin_tags_nav()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: data.tags.length })}
			</span>
			<Button size="sm" variant="ghost" onclick={() => (createOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_common_new()}
			</Button>
		</ListDetail.Toolbar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.tags.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_tags_empty()}</p>
					<p class="text-xs text-muted-foreground">{m.admin_tags_auto_hint()}</p>
				</Empty>
			{:else}
				{#each data.tags as tag (tag.id)}
					<ListDetail.Row href="/admin/posts/tags/{tag.id}" selected={selectedId === tag.id}>
						<IconTag class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-medium">{tag.name}</h3>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />
								{tag.slug}
							</p>
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{data.usageCounts[tag.id] ?? 0}
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
			<Dialog.Title>{m.admin_tags_dialog_create()}</Dialog.Title>
			<Dialog.Description>{m.admin_tags_dialog_create_desc()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/admin/posts/tags?/create"
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
				<Field.Field>
					<Field.FieldLabel for="new-tag-name">{m.admin_tags_name()}</Field.FieldLabel>
					<Input id="new-tag-name" name="name" required />
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="new-tag-slug">Slug</Field.FieldLabel>
					<Input
						id="new-tag-slug"
						name="slug"
						class="font-mono"
						placeholder={m.admin_categories_slug_hint()}
						required
					/>
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

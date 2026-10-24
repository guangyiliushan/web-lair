<script lang="ts">
	import type { LayoutData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let createOpen = $state(false);
	let createError = $state<string | null>(null);
	let sourceLang = $state('zh-cn');

	const localeLabels: Record<string, string> = {
		'zh-cn': '中文 (zh-cn)',
		en: 'English (en)',
		ja: '日本語 (ja)'
	};

	/** Selection lives in the route, so back/forward and deep links just work. */
	const selectedId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>{m.admin_categories_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={selectedId !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.nav_posts_categories()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: data.categories.length })}
			</span>
			<Button size="sm" variant="ghost" onclick={() => (createOpen = true)}>
				<IconPlus data-icon="inline-start" />
				{m.admin_common_new()}
			</Button>
		</ListDetail.Toolbar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.categories.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_categories_empty()}</p>
				</Empty>
			{:else}
				{#each data.categories as cat (cat.id)}
					<ListDetail.Row href="/admin/posts/categories/{cat.id}" selected={selectedId === cat.id}>
						<IconFolder class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-medium">{cat.name}</h3>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />
								{cat.slug}
							</p>
						</div>
						<span class="text-xs text-muted-foreground tabular-nums">
							{data.postCounts[cat.id] ?? 0}
						</span>
						<span
							class="shrink-0 text-[10px] text-muted-foreground tabular-nums"
							title={m.admin_taxonomy_section()}
						>
							{m.admin_taxonomy_completeness({ done: cat.completeness, total: 3 })}
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
			<Dialog.Title>{m.admin_categories_dialog_create()}</Dialog.Title>
			<Dialog.Description>{m.admin_categories_dialog_create_desc()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/admin/posts/categories?/create"
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
			<div class="flex flex-col gap-4 px-6 pb-4">
				<Field.Field>
					<Field.FieldLabel for="new-cat-lang">{m.admin_taxonomy_source_lang()}</Field.FieldLabel>
					<!-- bits-ui Select does not submit with the form; carry the value. -->
					<input type="hidden" name="sourceLang" value={sourceLang} />
					<Select.Root type="single" bind:value={sourceLang}>
						<Select.Trigger class="h-8 w-full" id="new-cat-lang">
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
					<Field.FieldLabel for="new-cat-name">{m.admin_categories_name()}</Field.FieldLabel>
					<Input id="new-cat-name" name="name" required />
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="new-cat-slug">Slug</Field.FieldLabel>
					<Input id="new-cat-slug" name="slug" required />
					<Field.FieldDescription>{m.admin_categories_slug_hint()}</Field.FieldDescription>
				</Field.Field>
			</div>
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

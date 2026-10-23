<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

	let formEl = $state<HTMLFormElement | null>(null);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let confirmOpen = $state(false);

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

	const afterDelete: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false, invalidateAll: false });
			if (result.type === 'success') await goto('/admin/posts/categories', { replaceState: true });
		};
	};
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<!-- Panel heading: focus lands here on open (a11y contract). -->
	<div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
		<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
			{data.category.name}
		</h1>
		<span class="shrink-0 font-mono text-xs text-muted-foreground">{data.category.slug}</span>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<form
			bind:this={formEl}
			method="POST"
			action="?/update"
			use:enhance
			class="flex flex-col gap-5 p-4"
		>
			<Field.FieldGroup>
				<Field.Field>
					<Field.FieldLabel for="cat-name">{m.admin_categories_name()}</Field.FieldLabel>
					<Input
						id="cat-name"
						name="name"
						value={data.category.name}
						oninput={onNameInput}
						required
					/>
				</Field.Field>
				<Field.Field>
					<Field.FieldLabel for="cat-slug">Slug</Field.FieldLabel>
					<Input
						id="cat-slug"
						name="slug"
						value={data.category.slug}
						oninput={onSlugInput}
						required
					/>
					<Field.FieldDescription>{m.admin_categories_slug_hint()}</Field.FieldDescription>
				</Field.Field>
			</Field.FieldGroup>

			<Field.FieldGroup>
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
						{m.admin_taxonomy_section()}
					</h2>
					<span class="shrink-0 text-xs text-muted-foreground">
						{m.admin_taxonomy_source_lang()}: {data.category.sourceLang}
					</span>
				</div>
				{#each translationFields as field (field.key)}
					<Field.Field>
						<Field.FieldLabel for={`cat-name-${field.key}`}>{field.label}</Field.FieldLabel>
						<Input
							id={`cat-name-${field.key}`}
							name={`name_${field.key}`}
							value={translationValue(field.key)}
							oninput={scheduleSave}
						/>
					</Field.Field>
				{/each}
			</Field.FieldGroup>

			{#if form?.error}
				<p role="alert" class="text-sm text-destructive">{form.error}</p>
			{/if}
		</form>

		<section class="flex flex-col gap-3 px-4 pb-6">
			<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				{m.admin_categories_posts_heading()}
			</h2>
			{#if data.related.length === 0}
				<p class="text-sm text-muted-foreground">{m.admin_categories_no_posts()}</p>
			{:else}
				<ul class="flex flex-col divide-y rounded-lg border">
					{#each data.related as post (post.id)}
						<li class="flex items-center gap-3 px-3 py-2.5">
							<span class="min-w-0 flex-1 truncate text-sm">{post.title}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{post.status}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>

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

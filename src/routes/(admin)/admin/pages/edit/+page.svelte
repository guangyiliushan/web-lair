<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { localeLabels } from '$lib/stores/locale.svelte';

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } =
		$props();

	const LOCALES = [
		{ code: 'en', label: localeLabels.en },
		{ code: 'zh-cn', label: localeLabels['zh-cn'] },
		{ code: 'ja', label: localeLabels.ja }
	] as const;

	let saved = $state(false);
</script>

<svelte:head>
	<title>{m.admin_pages_edit_title()} - Lair Admin</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
	{#if form?.error}
		<div
			role="alert"
			class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{form.error}
		</div>
	{:else if saved}
		<div
			role="status"
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
		>
			{m.admin_pages_saved()}
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<Badge variant={data.page.isDefault ? 'secondary' : 'outline'} class="text-xs">
			{data.page.isDefault ? m.admin_pages_default_page() : m.admin_pages_extra_page()}
		</Badge>
		<Badge variant="outline" class="text-xs">
			{data.page.hasContent ? m.admin_pages_md_page() : m.admin_pages_code_page()}
		</Badge>
		<span>slug: <span class="font-mono">{data.page.slug}</span></span>
	</div>

	<form
		method="POST"
		action="?/save"
		oninput={() => {
			saved = false;
		}}
		use:enhance={() => {
			saved = false;
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') saved = true;
			};
		}}
		class="flex flex-col gap-6"
	>
		<input type="hidden" name="id" value={data.page.id} />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">{m.admin_pages_edit_title_section()}</h2>
			{#each LOCALES as locale (locale.code)}
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
					<input
						type="text"
						name="title_{locale.code}"
						value={data.page.title[locale.code] ?? ''}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
			{/each}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">{m.admin_pages_edit_desc_section()}</h2>
			{#each LOCALES as locale (locale.code)}
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
					<input
						type="text"
						name="description_{locale.code}"
						value={data.page.description[locale.code] ?? ''}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
			{/each}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">{m.admin_pages_edit_props()}</h2>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground">{m.admin_pages_edit_icon()}</span>
				<input
					type="text"
					name="icon"
					value={data.page.icon}
					placeholder={m.admin_pages_edit_icon_ph()}
					class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
				/>
			</label>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground"
					>{m.admin_pages_edit_external()}</span
				>
				<input
					type="url"
					name="externalUrl"
					value={data.page.externalUrl}
					placeholder={m.admin_pages_edit_external_ph()}
					class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
				/>
			</label>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground">Slug</span>
				<input
					type="text"
					name="slug"
					value={data.page.slug}
					readonly={data.page.isDefault}
					class="h-9 w-full rounded-md border bg-transparent px-3 font-mono text-sm read-only:opacity-60"
				/>
			</label>
			{#if data.page.isDefault}
				<p class="text-xs text-muted-foreground">
					{m.admin_pages_edit_slug_default_hint()}
				</p>
			{:else if !data.page.hasContent}
				<p class="text-xs text-amber-600 dark:text-amber-400">
					{m.admin_pages_edit_slug_code_hint()}
				</p>
			{:else}
				<p class="text-xs text-muted-foreground">{m.admin_pages_edit_slug_note()}</p>
			{/if}
		</section>

		<div class="flex items-center gap-3">
			<Button type="submit">{m.admin_common_save()}</Button>
			<Button variant="outline" href="/admin/pages">{m.admin_common_back_to_list()}</Button>
		</div>
	</form>
</div>

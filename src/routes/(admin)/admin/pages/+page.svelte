<script lang="ts">
	import { goto, invalidateAll, afterNavigate } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { Separator } from '$lib/components/ui/separator';
	import { formatDateTime } from '$lib/utils/i18n';
	import { locales } from '$lib/paraglide/runtime';
	import { localeLabels } from '$lib/stores/locale.svelte';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconEyeOff from '@tabler/icons-svelte-runes/icons/eye-off';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } =
		$props();

	/** Locale rows for the external-entry dialog (same shape as the editor). */
	const LOCALES = locales.map((code) => ({ code, label: localeLabels[code] }));

	/** 「新增」双类型 (P5-3): the md type starts in the draft editor; the
	 * external entry inserts directly from the dialog below (no draft). */
	let createExternalOpen = $state(false);
	let creating = $state(false);

	type PageRow = (typeof data.pages)[number];

	// Default rows hide through a confirmation (three menu surfaces disappear,
	// direct access stays); deleting them is refused by the server as well.
	let hideTarget = $state<PageRow | null>(null);
	let deleteTarget = $state<PageRow | null>(null);

	// Writable derived (Svelte 5.25+): the refresh button clears the banner by
	// assignment; the next submission resyncs it from `form`.
	let errorText = $derived(form?.error ?? null);

	// ?discarded=1 flash (T12): transient banner after a discard redirects
	// back to the list (mirrors the editor's afterNavigate handling; NOT an
	// $effect - replaceState throws before the router is initialized).
	let flash = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	afterNavigate(() => {
		if (page.url.searchParams.get('discarded') !== '1') return;
		flash = m.admin_posts_edit_flash_discarded();
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 3500);
		const url = new URL(page.url);
		url.searchParams.delete('discarded');
		goto(url.pathname + url.search, { replaceState: true, noScroll: true });
	});

	// ▲/▼ dead zones (P2 review): defaults render first, so the first extra
	// row cannot move up and the last default row cannot move down.
	let submitting = $state(false);
	const firstExtraIndex = $derived(data.pages.findIndex((row) => !row.isDefault));
	const lastDefaultIndex = $derived(
		data.pages.reduce((last, row, index) => (row.isDefault ? index : last), -1)
	);
</script>

<svelte:head>
	<title>{m.admin_pages_title()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	{#if errorText}
		<div
			role="alert"
			class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{errorText}
		</div>
	{/if}

	<div class="relative flex h-10 shrink-0 items-center border-b">
		<div class="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
			<span class="truncate">{m.admin_pages_hint({ count: data.pages.length })}</span>
			{#if flash}
				<span
					class="shrink-0 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400"
				>
					{flash}
				</span>
			{/if}
		</div>
		<div class="absolute top-0 right-0 flex h-full items-center gap-1.5 pr-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="sm" variant="outline" class="h-7 gap-1 px-2.5 text-xs">
							<IconPlus class="size-3" />
							{m.admin_common_new()}
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Group>
						<DropdownMenu.Item onSelect={() => goto('/admin/pages/edit')}>
							{m.admin_pages_md_page()}
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => (createExternalOpen = true)}>
							{m.admin_pages_external()}
						</DropdownMenu.Item>
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton
				onclick={() => {
					errorText = null;
					invalidateAll();
				}}
			/>
		</div>
	</div>

	{#if data.pages.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">{m.admin_pages_empty()}</h3>
				<p class="text-sm text-muted-foreground">{m.admin_pages_seed_missing()}</p>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="table-fixed">
				<Table.Header>
					<Table.Row class="border-border">
						<Table.Head>{m.admin_pages_col_title()}</Table.Head>
						<Table.Head class="hidden w-44 sm:table-cell">Slug</Table.Head>
						<Table.Head class="hidden w-20 md:table-cell">{m.admin_common_status()}</Table.Head>
						<Table.Head class="w-28">{m.admin_pages_col_sort()}</Table.Head>
						<Table.Head class="hidden w-36 lg:table-cell">{m.admin_pages_col_updated()}</Table.Head>
						<Table.Head class="w-28 text-right">{m.admin_common_actions()}</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.pages as page, index (page.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 items-center gap-2">
									<a
										href="/admin/pages/edit?id={page.id}"
										class="truncate font-medium hover:text-primary"
									>
										{page.title}
									</a>
									{#if page.isDefault}
										<Badge variant="secondary" class="shrink-0 text-xs"
											>{m.admin_pages_default()}</Badge
										>
									{/if}
									<Badge variant="outline" class="shrink-0 text-xs">
										{page.externalUrl ? m.admin_pages_external() : m.admin_pages_internal()}
									</Badge>
									{#if page.hasDraft}
										<Badge variant="secondary" class="shrink-0 text-xs"
											>{m.admin_posts_unpublished_changes()}</Badge
										>
									{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-44 sm:table-cell">
								<span class="font-mono text-xs text-muted-foreground">{page.slug}</span>
							</Table.Cell>
							<Table.Cell class="hidden w-20 md:table-cell">
								<Badge
									variant={page.status === 'visible' ? 'default' : 'secondary'}
									class="text-xs"
								>
									{page.status === 'visible' ? m.admin_pages_visible() : m.admin_pages_hidden()}
								</Badge>
							</Table.Cell>
							<Table.Cell class="w-28">
								<div class="flex items-center gap-1">
									<form method="POST" action="?/move" use:enhance class="flex items-center">
										<input type="hidden" name="id" value={page.id} />
										<Button
											type="submit"
											name="direction"
											value="up"
											variant="ghost"
											size="icon"
											class="size-6"
											aria-label={m.admin_projects_move_up()}
											disabled={index === 0 || index === firstExtraIndex}
										>
											<IconArrowUp class="size-3.5" />
										</Button>
										<Button
											type="submit"
											name="direction"
											value="down"
											variant="ghost"
											size="icon"
											class="size-6"
											aria-label={m.admin_projects_move_down()}
											disabled={index === data.pages.length - 1 || index === lastDefaultIndex}
										>
											<IconArrowDown class="size-3.5" />
										</Button>
									</form>
									<span class="font-mono text-xs text-muted-foreground">{page.sortOrder}</span>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-36 text-xs text-muted-foreground lg:table-cell">
								{formatDateTime(new Date(page.updatedAt), {
									dateStyle: 'short',
									timeStyle: 'short'
								})}
							</Table.Cell>
							<Table.Cell class="w-28 text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										href="/admin/pages/edit?id={page.id}"
										aria-label={m.admin_common_edit()}
									>
										<IconPencil class="size-4" />
									</Button>
									{#if page.status === 'visible'}
										{#if page.isDefault}
											<Button
												variant="ghost"
												size="icon"
												class="size-8"
												aria-label={m.admin_pages_hide()}
												onclick={() => (hideTarget = page)}
											>
												<IconEyeOff class="size-4" />
											</Button>
										{:else}
											<form method="POST" action="?/setStatus" use:enhance>
												<input type="hidden" name="id" value={page.id} />
												<input type="hidden" name="status" value="hidden" />
												<Button
													type="submit"
													variant="ghost"
													size="icon"
													class="size-8"
													aria-label={m.admin_pages_hide()}
												>
													<IconEyeOff class="size-4" />
												</Button>
											</form>
										{/if}
									{:else}
										<form method="POST" action="?/setStatus" use:enhance>
											<input type="hidden" name="id" value={page.id} />
											<input type="hidden" name="status" value="visible" />
											<Button
												type="submit"
												variant="ghost"
												size="icon"
												class="size-8"
												aria-label={m.admin_pages_show()}
											>
												<IconEye class="size-4" />
											</Button>
										</form>
									{/if}
									{#if !page.isDefault}
										<Button
											variant="ghost"
											size="icon"
											class="size-8 text-destructive hover:text-destructive"
											aria-label={m.admin_common_delete()}
											onclick={() => (deleteTarget = page)}
										>
											<IconTrash class="size-4" />
										</Button>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<AlertDialog.Root open={hideTarget !== null} onOpenChange={(open) => !open && (hideTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_pages_hide_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_pages_hide_desc({ title: hideTarget?.title ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/setStatus"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update();
						submitting = false;
						if (result.type === 'success') hideTarget = null;
					};
				}}
			>
				<input type="hidden" name="id" value={hideTarget?.id ?? ''} />
				<input type="hidden" name="status" value="hidden" />
				<AlertDialog.Action type="submit" disabled={submitting}
					>{m.admin_pages_hide()}</AlertDialog.Action
				>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => !open && (deleteTarget = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_pages_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_pages_delete_desc({ title: deleteTarget?.title ?? '' })}{deleteTarget?.placeholder
					? m.admin_pages_delete_desc_placeholder()
					: deleteTarget?.hasContent
						? m.admin_pages_delete_desc_data()
						: m.admin_pages_delete_desc_code()}{#if !deleteTarget?.placeholder && deleteTarget?.hasDraft}{` ${m.admin_pages_delete_desc_draft()}`}{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/delete"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update();
						submitting = false;
						if (result.type === 'success') deleteTarget = null;
					};
				}}
			>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Action type="submit" disabled={submitting}
					>{m.admin_common_delete()}</AlertDialog.Action
				>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- External-entry dialog (P5-3): direct insert, no draft -->
<Dialog.Root
	open={createExternalOpen}
	onOpenChange={(open) => !open && (createExternalOpen = false)}
>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>{m.admin_pages_new_external()}</Dialog.Title>
			</Dialog.Header>
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					creating = true;
					return async ({ result, update }) => {
						await update();
						creating = false;
						if (result.type === 'success') {
							createExternalOpen = false;
							invalidateAll();
						}
					};
				}}
				class="flex flex-col gap-4 px-6 pb-6"
			>
				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-semibold">{m.admin_pages_edit_title_section()}</h3>
					{#each LOCALES as locale (locale.code)}
						<div class="flex items-center gap-3">
							<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
							<Input name="title_{locale.code}" />
						</div>
					{/each}
				</section>
				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-semibold">{m.admin_pages_edit_desc_section()}</h3>
					{#each LOCALES as locale (locale.code)}
						<div class="flex items-center gap-3">
							<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
							<Input name="description_{locale.code}" />
						</div>
					{/each}
				</section>
				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-semibold">{m.admin_pages_edit_props()}</h3>
					<div class="flex items-center gap-3">
						<span class="w-20 shrink-0 text-xs text-muted-foreground"
							>{m.admin_pages_edit_icon()}</span
						>
						<Input name="icon" placeholder={m.admin_pages_edit_icon_ph()} />
					</div>
					<div class="flex items-center gap-3">
						<span class="w-20 shrink-0 text-xs text-muted-foreground"
							>{m.admin_pages_edit_external()}</span
						>
						<Input name="externalUrl" placeholder={m.admin_pages_edit_external_ph()} />
					</div>
					<div class="flex items-center gap-3">
						<span class="w-20 shrink-0 text-xs text-muted-foreground">{m.admin_common_slug()}</span>
						<Input name="slug" class="font-mono" placeholder={m.admin_common_slug_ph()} />
					</div>
				</section>
				{#if form?.error}
					<p role="alert" class="text-sm text-destructive">{form.error}</p>
				{/if}
				<Dialog.Footer>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" disabled={creating}>{m.admin_common_save()}</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

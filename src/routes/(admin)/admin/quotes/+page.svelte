<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Empty } from '$lib/components/ui/empty';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { DeleteConfirm } from '$lib/components/admin';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';

	let { data, form }: PageProps = $props();

	type QuoteRow = Awaited<PageProps['data']['rows']>[number];

	// ── Add / edit dialog ──
	let dialogOpen = $state(false);
	let editing = $state<QuoteRow | null>(null);
	let fieldContent = $state('');
	let fieldAuthor = $state('');
	let fieldSource = $state('');
	// Double-submit guard (C3 review): kit does not merge submissions.
	let submitting = $state(false);

	// Dashboard 撰写 deep link: /admin/quotes?add=1 opens the dialog once.
	let addConsumed = false;
	$effect(() => {
		if (!addConsumed && page.url.searchParams.get('add') === '1') {
			addConsumed = true;
			openCreate();
		}
	});

	function openCreate() {
		dismissError();
		editing = null;
		fieldContent = '';
		fieldAuthor = '';
		fieldSource = '';
		dialogOpen = true;
	}

	function openEdit(row: QuoteRow) {
		dismissError();
		editing = row;
		fieldContent = row.content;
		fieldAuthor = row.author ?? '';
		fieldSource = row.source ?? '';
		dialogOpen = true;
	}

	/** Close the dialog once an action succeeds; failures keep it open with the error shown. */
	function closeOnSuccess() {
		return async ({
			result,
			update
		}: {
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
		}) => {
			submitting = false;
			if (result.type !== 'failure') dialogOpen = false;
			await update();
		};
	}

	// ── Delete confirm ──
	let deleteTarget = $state<QuoteRow | null>(null);

	function openDelete(row: QuoteRow) {
		dismissError();
		deleteTarget = row;
	}

	// Round-4 review: a page-form error belongs to the action that produced
	// it; any older failure is dismissed when a dialog opens (a fresh result
	// is a new `form` object and re-enables the message).
	let errorDismissedFor: unknown = null;

	const errorMessage = $derived(
		form && form !== errorDismissedFor && 'error' in form && typeof form.error === 'string'
			? form.error
			: null
	);

	function dismissError() {
		errorDismissedFor = form;
	}
</script>

<svelte:head>
	<title>{m.admin_quotes_title()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center border bg-muted text-muted-foreground"
			>
				<IconQuote class="size-4" />
			</span>
			<div class="flex min-w-0 items-baseline gap-2">
				<h1 class="truncate text-base font-semibold">{m.admin_nav_quotes()}</h1>
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums"
					>{m.admin_common_count_entries({ count: data.total })}</span
				>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline" onclick={openCreate}>
				<IconPlus class="size-3.5" />
				{m.admin_quotes_add()}
			</Button>
		</div>
	</header>

	<!-- 添加 / 编辑摘录对话框 -->
	<Dialog.Root bind:open={dialogOpen}>
		<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
			<form
				method="post"
				action={editing ? '?/update' : '?/create'}
				class="flex flex-col"
				use:enhance={() => {
					submitting = true;
					return closeOnSuccess();
				}}
			>
				{#if editing}
					<input type="hidden" name="id" value={editing.id} />
				{/if}
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<Dialog.Title>{editing ? m.admin_quotes_edit() : m.admin_quotes_add()}</Dialog.Title>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button
								variant="ghost"
								size="icon"
								class="size-7"
								{...props}
								aria-label={m.admin_common_close()}
							>
								<IconX class="size-4" />
							</Button>
						{/snippet}
					</Dialog.Close>
				</div>
				{#if errorMessage}
					<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
				{/if}
				<div class="grid gap-4 px-5 py-4">
					<div class="grid gap-1.5">
						<label for="quote-content" class="text-sm font-medium">
							{m.admin_quotes_content()}<span class="text-destructive"> *</span>
						</label>
						<Textarea
							id="quote-content"
							name="content"
							class="min-h-28"
							placeholder={m.admin_quotes_content_ph()}
							bind:value={fieldContent}
							required
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="quote-author" class="text-sm font-medium">{m.admin_quotes_author()}</label>
						<Input
							id="quote-author"
							name="author"
							placeholder={m.admin_quotes_author_ph()}
							bind:value={fieldAuthor}
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="quote-source" class="text-sm font-medium">{m.admin_quotes_source()}</label>
						<Input
							id="quote-source"
							name="source"
							placeholder={m.admin_quotes_source_ph()}
							bind:value={fieldSource}
						/>
					</div>
				</div>
				<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" size="sm" disabled={submitting || !fieldContent.trim()}>
						{editing ? m.admin_common_save() : m.admin_common_add()}
					</Button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Root>

	<DeleteConfirm
		open={deleteTarget !== null}
		title={m.admin_quotes_delete_title()}
		description={m.admin_quotes_delete_desc()}
		id={deleteTarget?.id ?? ''}
		error={errorMessage}
		onclose={() => (deleteTarget = null)}
	/>

	<!-- 摘录列表（流式加载：先骨架后内容，ui-ux C1） -->
	<div class="min-h-0 flex-1 overflow-auto">
		{#await data.rows}
			<div class="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6" aria-hidden="true">
				{#each [0, 1, 2, 3, 4] as i (i)}
					<Skeleton class="h-20 w-full" />
				{/each}
			</div>
		{:then rows}
			{#if rows.length === 0}
				<Empty class="py-12">
					<div class="flex flex-col items-center gap-1">
						<h3 class="text-lg font-semibold tracking-tight">{m.admin_quotes_empty()}</h3>
						<p class="text-sm text-muted-foreground">{m.admin_quotes_empty_desc()}</p>
					</div>
				</Empty>
			{:else}
				<div class="mx-auto max-w-5xl" role="list" aria-label={m.admin_quotes_list_aria()}>
					{#each rows as row (row.id)}
						<article
							role="listitem"
							class="group border-b px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/50"
						>
							<div class="flex gap-3">
								<IconQuote class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
								<div class="min-w-0 flex-1">
									<p class="text-base leading-relaxed">{row.content}</p>
									<div
										class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
									>
										{#if row.author}
											<span>{row.author}</span>
										{/if}
										{#if row.source}
											<span class="italic"
												>{m.admin_quotes_source_wrap({ source: row.source })}</span
											>
										{/if}
										<span class="text-muted-foreground/70">{row.dateLabel}</span>
									</div>
								</div>
								<div
									class="flex shrink-0 items-start gap-1 opacity-100 transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 sm:pointer-fine:opacity-0"
								>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 px-2 text-xs"
										aria-label={m.admin_quotes_edit()}
										onclick={() => openEdit(row)}
									>
										<IconPencil class="size-3.5" />
										<span class="hidden sm:inline">{m.admin_common_edit()}</span>
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
										aria-label={m.admin_quotes_delete_title()}
										onclick={() => openDelete(row)}
									>
										<IconTrash class="size-3.5" />
										<span class="hidden sm:inline">{m.admin_common_delete()}</span>
									</Button>
								</div>
							</div>
						</article>
					{/each}
				</div>
			{/if}
		{/await}
	</div>
</div>

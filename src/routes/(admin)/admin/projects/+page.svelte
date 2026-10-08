<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { ActionResult } from '@sveltejs/kit';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Empty from '$lib/components/ui/empty';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { DeleteConfirm } from '$lib/components/admin';
	import { m } from '$lib/paraglide/messages';
	import {
		PROJECT_PROVIDER_LABEL_KEYS,
		PROJECT_STATUSES,
		PROJECT_STATUS_LABEL_KEYS,
		PROJECT_SYNC_PROVIDERS,
		isProjectProvider
	} from '$lib/utils/project-meta';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconFileImport from '@tabler/icons-svelte-runes/icons/file-import';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconArrowBarToUp from '@tabler/icons-svelte-runes/icons/arrow-bar-to-up';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import type { PageProps } from './$types';

	/**
	 * Admin projects surface (batch A, plan §4): real queue replacing the
	 * mockup. Rows are not wrapped in one giant form - the checkboxes feed a
	 * client-side selection set and the bulk action bar posts the selected
	 * ids; per-row sort buttons live in their own small reorder forms.
	 */
	let { data, form }: PageProps = $props();

	type BaseRow = {
		id: string;
		name: string;
		description: string | null;
		provider: string;
		externalId: string | null;
		projectUrl: string | null;
		previewUrl: string | null;
		docUrl: string | null;
		avatar: string | null;
		language: string | null;
		stars: number | null;
		pushedAt: Date | null;
		archived: boolean;
		fork: boolean;
		status: string;
		sortOrder: number;
		lastSyncedAt: Date | null;
		lastErrorKind: string | null;
	};

	const BRANDS: Record<string, string> = {
		github: 'GitHub',
		gitlab: 'GitLab',
		gitee: 'Gitee',
		bitbucket: 'Bitbucket'
	};
	const PROVIDER_FNS: Record<string, () => string> = {
		projects_badge_site: m.projects_badge_site,
		projects_badge_other: m.projects_badge_other
	};
	const STATUS_FNS: Record<string, () => string> = {
		admin_projects_status_pending: m.admin_projects_status_pending,
		admin_projects_status_published: m.admin_projects_status_published,
		admin_projects_status_hidden: m.admin_projects_status_hidden,
		admin_projects_status_rejected: m.admin_projects_status_rejected
	};
	const ERROR_FNS: Record<string, () => string> = {
		not_found: m.admin_projects_error_not_found,
		rate_limited: m.admin_projects_error_rate_limited,
		auth: m.admin_projects_error_auth,
		network: m.admin_projects_error_network,
		parse: m.admin_projects_error_parse
	};
	const RUN_FNS: Record<string, () => string> = {
		queued: m.admin_projects_run_queued,
		running: m.admin_projects_run_running,
		succeeded: m.admin_projects_run_succeeded,
		failed: m.admin_projects_run_failed,
		skipped: m.admin_projects_run_skipped
	};

	function providerLabel(provider: string): string {
		if (isProjectProvider(provider)) {
			const key = PROJECT_PROVIDER_LABEL_KEYS[provider];
			if (key !== null) return (PROVIDER_FNS[key] ?? (() => provider))();
		}
		return BRANDS[provider] ?? provider;
	}

	function statusLabel(status: string): string {
		const key = (PROJECT_STATUS_LABEL_KEYS as Record<string, string>)[status];
		return key ? (STATUS_FNS[key] ?? (() => status))() : status;
	}

	// ── Flash / page error (quotes-page pattern) ──
	let errorDismissedFor: unknown = null;
	const errorMessage = $derived(
		form && form !== errorDismissedFor && 'error' in form && typeof form.error === 'string'
			? form.error
			: null
	);
	function dismissError() {
		errorDismissedFor = form;
	}

	const flashText = $derived.by(() => {
		if (!form || !('flash' in form) || typeof form.flash !== 'string') return null;
		switch (form.flash) {
			case 'sync-queued':
				return m.admin_projects_flash_sync_queued();
			case 'sync-dedup':
				return m.admin_projects_flash_sync_dedup();
			case 'created':
				return m.admin_projects_flash_created();
			case 'updated':
				return m.admin_projects_flash_updated();
			case 'deleted':
				return m.admin_projects_flash_deleted();
			case 'targets-saved':
				return m.admin_projects_flash_targets_saved();
			case 'status-changed':
				return m.admin_projects_flash_status({
					updated: Number('updated' in form ? form.updated : 0),
					skipped: Number('skipped' in form ? form.skipped : 0)
				});
			default:
				return null;
		}
	});

	// ── Selection (bulk bar) ──
	let selectedIds = $state<string[]>([]);
	let bulkDeleteOpen = $state(false);
	let submitting = $state(false);

	// ── Edit dialog ──
	let editOpen = $state(false);
	let editing = $state<BaseRow | null>(null);
	let fieldName = $state('');
	let fieldDescription = $state('');
	let fieldProjectUrl = $state('');
	let fieldPreviewUrl = $state('');
	let fieldDocUrl = $state('');
	let fieldAvatar = $state('');

	function openEdit(row: BaseRow) {
		dismissError();
		editing = row;
		fieldName = row.name;
		fieldDescription = row.description ?? '';
		fieldProjectUrl = row.projectUrl ?? '';
		fieldPreviewUrl = row.previewUrl ?? '';
		fieldDocUrl = row.docUrl ?? '';
		fieldAvatar = row.avatar ?? '';
		editOpen = true;
	}

	// Deep link (?id=): open the edit dialog for the loaded focus row once.
	let focusConsumed: string | null = null;
	$effect(() => {
		if (data.focusRow && data.focusRow.id !== focusConsumed) {
			focusConsumed = data.focusRow.id;
			openEdit(data.focusRow);
		}
	});

	// ── Create dialog ──
	let createOpen = $state(false);
	let createProvider = $state<'site' | 'other'>('site');
	let createExternalId = $state<string | null>(null);
	let createFullName = $state<string | null>(null);
	/** Platform of a repo-import prefill (hidden provider input). */
	let createProviderRaw = $state<string>('');

	function providerFromPrefill(): string {
		return createProviderRaw;
	}

	function resetCreateFields() {
		fieldName = '';
		fieldDescription = '';
		fieldProjectUrl = '';
		fieldPreviewUrl = '';
		fieldDocUrl = '';
		fieldAvatar = '';
		createProvider = 'site';
		createExternalId = null;
		createFullName = null;
		createProviderRaw = '';
	}

	function openCreate() {
		dismissError();
		resetCreateFields();
		createOpen = true;
	}

	interface ImportPrefillPayload {
		provider: string;
		name: string;
		description: string | null;
		projectUrl: string;
		previewUrl: string | null;
		avatar: string | null;
		externalId: string | null;
		fullName: string | null;
		existing: { id: string; status: string } | null;
	}

	// ── Import dialog ──
	let importOpen = $state(false);
	let importUrl = $state('');
	let importExisting = $state<{ id: string; status: string } | null>(null);

	function openImport() {
		dismissError();
		importUrl = '';
		importExisting = null;
		importOpen = true;
	}

	function applyPrefill(prefill: ImportPrefillPayload) {
		createExternalId = prefill.externalId;
		createFullName = prefill.fullName;
		if (prefill.externalId) {
			createProviderRaw = prefill.provider;
		} else {
			// OG imports land as site/other (§4.4); honor the resolved default.
			createProvider = prefill.provider === 'other' ? 'other' : 'site';
		}
		fieldName = prefill.name;
		fieldDescription = prefill.description ?? '';
		fieldProjectUrl = prefill.projectUrl;
		fieldPreviewUrl = prefill.previewUrl ?? '';
		fieldDocUrl = '';
		fieldAvatar = prefill.avatar ?? '';
	}

	// ── Targets dialog ──
	let targetsOpen = $state(false);
	let targetRows = $state<{ provider: string; account: string }[]>([]);

	function openTargets() {
		dismissError();
		targetRows = data.targets.map((target) => ({ ...target }));
		targetsOpen = true;
	}

	// ── Single delete ──
	let deleteTarget = $state<BaseRow | null>(null);

	/** Close a dialog once its action succeeds; failures keep it open. */
	function closeOnSuccess(close: () => void) {
		return async ({
			result,
			update
		}: {
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
		}) => {
			submitting = false;
			if (result.type === 'success') close();
			await update();
		};
	}

	async function importSubmitter() {
		submitting = true;
		return async ({
			result,
			update
		}: {
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
		}) => {
			submitting = false;
			if (result.type === 'success' && result.data && 'importResult' in result.data) {
				const prefill = result.data.importResult as ImportPrefillPayload;
				importExisting = prefill.existing;
				applyPrefill(prefill);
				if (!prefill.existing) {
					importOpen = false;
					createOpen = true;
				}
			}
			await update();
		};
	}

	const runResult = $derived(data.lastRun?.result as Record<string, unknown> | null);

	function runNumber(key: string): number {
		const value = runResult?.[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}

	interface RunFailure {
		provider: string;
		account: string;
		repo: string | null;
		kind: string;
	}

	const runFailures = $derived(
		Array.isArray(runResult?.failures) ? (runResult.failures as RunFailure[]) : []
	);

	/** Selection must not survive a tab switch: the bulk bar would act on rows
	 * that are no longer visible (review). */
	let lastFilter: string = untrack(() => data.filter);
	$effect(() => {
		if (data.filter !== lastFilter) {
			lastFilter = data.filter;
			selectedIds = [];
		}
	});

	function isSyncProvider(provider: string): boolean {
		return (PROJECT_SYNC_PROVIDERS as readonly string[]).includes(provider);
	}
</script>

<svelte:head>
	<title>项目管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				class="inline-flex size-6 shrink-0 items-center justify-center border bg-muted text-muted-foreground"
			>
				<IconFolder class="size-4" />
			</span>
			<div class="flex min-w-0 items-baseline gap-2">
				<h1 class="truncate text-base font-semibold">{data.headerTitle}</h1>
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
					{data.counts.all} 条
				</span>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<form method="post" action="?/sync" use:enhance={() => closeOnSuccess(() => {})}>
				<Button type="submit" size="sm" variant="outline" disabled={submitting}>
					<IconRefresh class="size-3.5" />
					{m.admin_projects_sync()}
				</Button>
			</form>
			<Button size="sm" variant="outline" onclick={openTargets}>
				{m.admin_projects_targets()}
			</Button>
			<Button size="sm" variant="outline" onclick={openImport}>
				<IconFileImport class="size-3.5" />
				{m.admin_projects_import()}
			</Button>
			<Button size="sm" variant="outline" onclick={openCreate}>
				<IconPlus class="size-3.5" />
				{m.admin_projects_new()}
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<p role="alert" class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
			{errorMessage}
		</p>
	{/if}
	{#if flashText}
		<p role="status" class="border-b bg-muted px-4 py-2 text-sm text-muted-foreground">
			{flashText}
		</p>
	{/if}

	<div class="flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-xs text-muted-foreground">
		<span class="font-medium">{m.admin_projects_last_run()}:</span>
		{#if data.lastRun}
			<span class="rounded border px-1.5 py-0.5"
				>{RUN_FNS[data.lastRun.status]?.() ?? data.lastRun.status}</span
			>
			{#if runResult}
				<span>
					{m.admin_projects_sync_summary({
						added: runNumber('added'),
						updated: runNumber('updated'),
						skipped: runNumber('skipped'),
						failed: runNumber('failed')
					})}
				</span>
			{/if}
			<span>{data.lastRun.createdLabel}</span>
			{#if runFailures.length > 0}
				<details class="w-full">
					<summary class="cursor-pointer">{m.admin_projects_failures()}</summary>
					<ul class="mt-1 grid gap-0.5 pl-4">
						{#each runFailures as failure, index (index)}
							<li>
								{failure.provider}/{failure.account}{failure.repo ? ` · ${failure.repo}` : ''} — {ERROR_FNS[
									failure.kind
								]?.() ?? failure.kind}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		{:else}
			<span>{m.admin_projects_last_run_none()}</span>
		{/if}
	</div>

	<nav
		class="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2"
		aria-label="状态筛选"
	>
		<a
			href="?status=all"
			class="rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors {data.filter ===
			'all'
				? 'bg-primary/10 text-primary'
				: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
			aria-current={data.filter === 'all' ? 'true' : undefined}
		>
			{m.admin_projects_tab_all()} ({data.counts.all})
		</a>
		{#each PROJECT_STATUSES as status (status)}
			<a
				href="?status={status}"
				class="rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors {data.filter ===
				status
					? 'bg-primary/10 text-primary'
					: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
				aria-current={data.filter === status ? 'true' : undefined}
			>
				{statusLabel(status)} ({data.counts[status]})
			</a>
		{/each}
	</nav>

	{#if selectedIds.length > 0}
		<form
			method="post"
			action="?/setStatus"
			class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-2"
		>
			{#each selectedIds as id (id)}
				<input type="hidden" name="ids" value={id} />
			{/each}
			<span class="text-xs text-muted-foreground">已选 {selectedIds.length} 项</span>
			<Button type="submit" size="sm" variant="outline" name="to" value="published">
				{m.admin_projects_bulk_approve()}
			</Button>
			<Button type="submit" size="sm" variant="outline" name="to" value="rejected">
				{m.admin_projects_bulk_reject()}
			</Button>
			<Button type="submit" size="sm" variant="outline" name="to" value="hidden">
				{m.admin_projects_bulk_hide()}
			</Button>
			<Button type="submit" size="sm" variant="outline" name="to" value="pending">
				{m.admin_projects_bulk_restore_pending()}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
				onclick={() => (bulkDeleteOpen = true)}
			>
				{m.admin_projects_bulk_delete()}
			</Button>
			<Button type="button" size="sm" variant="ghost" onclick={() => (selectedIds = [])}>
				取消选择
			</Button>
		</form>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#await data.rows}
			<div class="grid gap-2 p-4" aria-hidden="true">
				{#each [0, 1, 2, 3] as i (i)}
					<Skeleton class="h-16 w-full" />
				{/each}
			</div>
		{:then rows}
			{#if rows.length === 0}
				<div class="p-4">
					<Empty.Root>
						<Empty.Header>
							<Empty.Title>{m.admin_projects_empty()}</Empty.Title>
						</Empty.Header>
					</Empty.Root>
				</div>
			{:else}
				<ul class="divide-y">
					{#each rows as row (row.id)}
						<li class="flex items-start gap-3 px-4 py-3">
							<input
								type="checkbox"
								class="mt-1"
								value={row.id}
								bind:group={selectedIds}
								aria-label="{row.name} 选择"
							/>
							<div
								class="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40"
							>
								{#if row.avatar}
									<img src={row.avatar} alt="" class="size-full object-cover" loading="lazy" />
								{:else}
									<span class="text-sm font-semibold uppercase">{row.name.slice(0, 1)}</span>
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="truncate text-sm font-medium">{row.name}</span>
									{#if row.archived}
										<span class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
											{m.projects_badge_archived()}
										</span>
									{/if}
									{#if row.fork}
										<span class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
											{m.admin_projects_badge_fork()}
										</span>
									{/if}
								</div>
								{#if row.description}
									<p class="mt-0.5 truncate text-xs text-muted-foreground">{row.description}</p>
								{/if}
								<div
									class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
								>
									<span class="rounded border px-1.5 py-0.5">{providerLabel(row.provider)}</span>
									<span class="rounded border px-1.5 py-0.5">{statusLabel(row.status)}</span>
									{#if row.syncedLabel}
										<span>{row.syncedLabel}</span>
									{/if}
									{#if row.lastErrorKind}
										<span class="text-destructive">
											{ERROR_FNS[row.lastErrorKind]?.() ?? row.lastErrorKind}
										</span>
									{/if}
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								<form method="post" action="?/reorder" use:enhance={() => closeOnSuccess(() => {})}>
									<input type="hidden" name="id" value={row.id} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										name="move"
										value="up"
										aria-label={m.admin_projects_move_up()}
									>
										<IconArrowUp class="size-3.5" />
									</Button>
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										name="move"
										value="down"
										aria-label={m.admin_projects_move_down()}
									>
										<IconArrowDown class="size-3.5" />
									</Button>
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										name="move"
										value="top"
										aria-label={m.admin_projects_move_top()}
									>
										<IconArrowBarToUp class="size-3.5" />
									</Button>
								</form>
								<Button
									size="sm"
									variant="ghost"
									onclick={() => openEdit(row)}
									aria-label={m.admin_projects_edit_title()}
								>
									<IconPencil class="size-3.5" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									class="text-destructive hover:bg-destructive/10 hover:text-destructive"
									onclick={() => {
										dismissError();
										deleteTarget = row;
									}}
									aria-label={m.admin_projects_bulk_delete()}
								>
									<IconTrash class="size-3.5" />
								</Button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/await}
	</div>
</div>

<!-- Edit dialog -->
<Dialog.Root bind:open={editOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		{#if editing}
			<form
				method="post"
				action="?/update"
				class="flex flex-col"
				use:enhance={() => {
					submitting = true;
					return closeOnSuccess(() => (editOpen = false));
				}}
			>
				<input type="hidden" name="id" value={editing.id} />
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
					<Dialog.Title>{m.admin_projects_edit_title()}</Dialog.Title>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
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
						<label for="project-name" class="text-sm font-medium">
							{m.admin_projects_field_name()}<span class="text-destructive"> *</span>
						</label>
						<Input id="project-name" name="name" bind:value={fieldName} required />
					</div>
					<div class="grid gap-1.5">
						<label for="project-description" class="text-sm font-medium">
							{m.admin_projects_field_description()}
						</label>
						<Textarea
							id="project-description"
							name="description"
							class="min-h-20"
							bind:value={fieldDescription}
						/>
					</div>
					<div class="grid gap-1.5">
						<label for="project-url" class="text-sm font-medium">
							{m.admin_projects_field_project_url()}<span class="text-destructive"> *</span>
						</label>
						<Input
							id="project-url"
							name="projectUrl"
							bind:value={fieldProjectUrl}
							readonly={isSyncProvider(editing.provider)}
							required
						/>
						{#if isSyncProvider(editing.provider)}
							<p class="text-xs text-muted-foreground">
								仓库行的主链接由同步维护（以平台 API 为准）。
							</p>
						{/if}
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="grid gap-1.5">
							<label for="project-preview" class="text-sm font-medium">
								{m.admin_projects_field_preview_url()}
							</label>
							<Input id="project-preview" name="previewUrl" bind:value={fieldPreviewUrl} />
						</div>
						<div class="grid gap-1.5">
							<label for="project-doc" class="text-sm font-medium">
								{m.admin_projects_field_doc_url()}
							</label>
							<Input id="project-doc" name="docUrl" bind:value={fieldDocUrl} />
						</div>
					</div>
					<div class="grid gap-1.5">
						<label for="project-avatar" class="text-sm font-medium">
							{m.admin_projects_field_avatar()}
						</label>
						<Input id="project-avatar" name="avatar" bind:value={fieldAvatar} />
					</div>
					<section class="grid gap-1.5 border-t pt-3">
						<h3 class="text-sm font-medium">{m.admin_projects_snapshot()}</h3>
						<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
							<dt>{m.admin_projects_field_provider()}</dt>
							<dd>{providerLabel(editing.provider)}</dd>
							<dt>Status</dt>
							<dd>{statusLabel(editing.status)}</dd>
							<dt>Language</dt>
							<dd>{editing.language ?? '—'}</dd>
							<dt>Stars</dt>
							<dd>{editing.stars ?? '—'}</dd>
							<dt>Pushed</dt>
							<dd>{editing.pushedAt ? editing.pushedAt.toISOString().slice(0, 10) : '—'}</dd>
							<dt>{m.admin_projects_last_run()}</dt>
							<dd>
								{editing.lastSyncedAt ? editing.lastSyncedAt.toISOString().slice(0, 10) : '—'}
							</dd>
							<dt>External ID</dt>
							<dd class="truncate">{editing.externalId ?? '—'}</dd>
						</dl>
					</section>
				</div>
				<div class="flex justify-end gap-2 border-t px-5 py-3">
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" {...props}>取消</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" disabled={submitting}>保存</Button>
				</div>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<!-- Create / import-prefilled dialog -->
<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form
			method="post"
			action="?/create"
			class="flex flex-col"
			use:enhance={() => {
				submitting = true;
				return closeOnSuccess(() => (createOpen = false));
			}}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_projects_new_title()}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			{#if errorMessage}
				<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
			{/if}
			<div class="grid gap-4 px-5 py-4">
				{#if createExternalId}
					<input type="hidden" name="provider" value={providerFromPrefill()} />
					<input type="hidden" name="externalId" value={createExternalId} />
					{#if createFullName}
						<input type="hidden" name="fullName" value={createFullName} />
					{/if}
					<p class="text-xs text-muted-foreground">
						{m.admin_projects_field_provider()}: {providerFromPrefill()}
					</p>
				{:else}
					<div class="grid gap-1.5">
						<label for="project-provider" class="text-sm font-medium">
							{m.admin_projects_field_provider()}
						</label>
						<select
							id="project-provider"
							name="provider"
							class="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
							bind:value={createProvider}
						>
							<option value="site">{m.projects_badge_site()}</option>
							<option value="other">{m.projects_badge_other()}</option>
						</select>
					</div>
				{/if}
				<div class="grid gap-1.5">
					<label for="project-create-name" class="text-sm font-medium">
						{m.admin_projects_field_name()}<span class="text-destructive"> *</span>
					</label>
					<Input id="project-create-name" name="name" bind:value={fieldName} required />
				</div>
				<div class="grid gap-1.5">
					<label for="project-create-description" class="text-sm font-medium">
						{m.admin_projects_field_description()}
					</label>
					<Textarea
						id="project-create-description"
						name="description"
						class="min-h-20"
						bind:value={fieldDescription}
					/>
				</div>
				<div class="grid gap-1.5">
					<label for="project-create-url" class="text-sm font-medium">
						{m.admin_projects_field_project_url()}<span class="text-destructive"> *</span>
					</label>
					<Input id="project-create-url" name="projectUrl" bind:value={fieldProjectUrl} required />
				</div>
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="grid gap-1.5">
						<label for="project-create-preview" class="text-sm font-medium">
							{m.admin_projects_field_preview_url()}
						</label>
						<Input id="project-create-preview" name="previewUrl" bind:value={fieldPreviewUrl} />
					</div>
					<div class="grid gap-1.5">
						<label for="project-create-doc" class="text-sm font-medium">
							{m.admin_projects_field_doc_url()}
						</label>
						<Input id="project-create-doc" name="docUrl" bind:value={fieldDocUrl} />
					</div>
				</div>
				<div class="grid gap-1.5">
					<label for="project-create-avatar" class="text-sm font-medium">
						{m.admin_projects_field_avatar()}
					</label>
					<Input id="project-create-avatar" name="avatar" bind:value={fieldAvatar} />
				</div>
			</div>
			<div class="flex justify-end gap-2 border-t px-5 py-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={submitting}>创建</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Import from URL -->
<Dialog.Root bind:open={importOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form method="post" action="?/import" class="flex flex-col" use:enhance={importSubmitter}>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_projects_import_title()}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			{#if errorMessage}
				<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
			{/if}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-xs text-muted-foreground">{m.admin_projects_import_desc()}</p>
				<div class="grid gap-1.5">
					<label for="project-import-url" class="text-sm font-medium">
						{m.admin_projects_import_url()}
					</label>
					<Input
						id="project-import-url"
						name="url"
						placeholder="https://github.com/owner/repo"
						bind:value={importUrl}
						required
					/>
				</div>
				{#if importExisting}
					<p role="status" class="text-sm">
						{m.admin_projects_import_existing({ status: statusLabel(importExisting.status) })}
						<a
							class="underline"
							href="?status=all&id={importExisting.id}"
							onclick={() => (importOpen = false)}
						>
							→
						</a>
					</p>
				{/if}
			</div>
			<div class="flex justify-end gap-2 border-t px-5 py-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={submitting}>
					{m.admin_projects_import_fetch()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Sync targets -->
<Dialog.Root bind:open={targetsOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form
			method="post"
			action="?/targets"
			class="flex flex-col"
			use:enhance={() => {
				submitting = true;
				return closeOnSuccess(() => (targetsOpen = false));
			}}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_projects_targets_title()}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			{#if errorMessage}
				<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
			{/if}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-xs text-muted-foreground">{m.admin_projects_targets_desc()}</p>
				{#each targetRows as target, index (index)}
					<div class="flex items-center gap-2">
						<select
							name="provider_{index}"
							class="h-9 w-32 rounded-md border border-input bg-transparent px-2 text-sm"
							bind:value={target.provider}
							aria-label={m.admin_projects_targets_provider()}
						>
							{#each PROJECT_SYNC_PROVIDERS as provider (provider)}
								<option value={provider}>{BRANDS[provider] ?? provider}</option>
							{/each}
						</select>
						<Input
							name="account_{index}"
							class="flex-1"
							placeholder={m.admin_projects_targets_account()}
							bind:value={target.account}
							aria-label={m.admin_projects_targets_account()}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onclick={() => (targetRows = targetRows.filter((_, i) => i !== index))}
							aria-label="移除"
						>
							<IconX class="size-3.5" />
						</Button>
					</div>
				{/each}
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => (targetRows = [...targetRows, { provider: 'github', account: '' }])}
				>
					<IconPlus class="size-3.5" />
					{m.admin_projects_targets_add()}
				</Button>
			</div>
			<div class="flex justify-end gap-2 border-t px-5 py-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={submitting}>保存</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Bulk delete confirm -->
<AlertDialog.Root bind:open={bulkDeleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_projects_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_projects_delete_warning()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="flex justify-end gap-2">
			<!-- Cancel stays OUTSIDE the destructive form: a bits-ui cancel
			     button submits when placed inside one (review P1). -->
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form method="post" action="?/delete">
				{#each selectedIds as id (id)}
					<input type="hidden" name="ids" value={id} />
				{/each}
				<Button
					type="submit"
					variant="outline"
					class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
					onclick={() => (bulkDeleteOpen = false)}
				>
					{m.admin_projects_bulk_delete()}
				</Button>
			</form>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Single delete confirm -->
<DeleteConfirm
	open={deleteTarget !== null}
	title={m.admin_projects_delete_title()}
	description={m.admin_projects_delete_warning()}
	id={deleteTarget?.id ?? ''}
	error={errorMessage}
	onclose={() => (deleteTarget = null)}
/>

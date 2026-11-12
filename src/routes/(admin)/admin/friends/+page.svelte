<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Empty } from '$lib/components/ui/empty';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { DeleteConfirm } from '$lib/components/admin';
	import { ListRowActions, ListTable, listColumnClass } from '$lib/components/admin/list-table';
	import { cols, columns } from './columns';
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import { m } from '$lib/paraglide/messages';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import type { PageProps } from './$types';
	import type { LinkStatus } from '$lib/utils/link-meta';

	/**
	 * Friends console (links L3). Real rows only: the state lives in `?state=`
	 * and the filter is the shared ToggleGroup (projects / comments use the same
	 * one) - never `role=tab`, since a tab without a tabpanel would be an ARIA
	 * lie. Dialogs own the review matrix; the row menu only offers edges the
	 * service allows.
	 */
	let { data, form }: PageProps = $props();

	type Row = Awaited<typeof data.rows>[number];

	const STATES: LinkStatus[] = ['approved', 'pending', 'outdated', 'rejected', 'banned'];
	const STATE_TEXT: Record<string, () => string> = {
		approved: m.admin_friends_state_friends,
		pending: m.admin_friends_state_pending,
		outdated: m.admin_friends_state_outdated,
		rejected: m.admin_friends_state_rejected,
		banned: m.admin_friends_state_banned
	};
	const ERROR_KIND_TEXT: Record<string, () => string> = {
		dns: m.admin_friends_kind_dns,
		connect: m.admin_friends_kind_connect,
		tls: m.admin_friends_kind_tls,
		timeout: m.admin_friends_kind_timeout,
		http_gone: m.admin_friends_kind_http_gone,
		http_error: m.admin_friends_kind_http_error,
		waf: m.admin_friends_kind_waf,
		robots: m.admin_friends_kind_robots,
		offsite: m.admin_friends_kind_offsite,
		unsupported: m.admin_friends_kind_unsupported,
		redirect: m.admin_friends_kind_redirect,
		page_missing: m.admin_friends_kind_page_missing,
		link_missing: m.admin_friends_kind_link_missing
	};

	function errorKindText(kind: string | null | undefined): string {
		if (!kind) return '';
		return ERROR_KIND_TEXT[kind]?.() ?? kind;
	}

	function fmt(value: Date | string | null | undefined): string {
		if (!value) return '—';
		const date = value instanceof Date ? value : new Date(value);
		return formatDateTime(date, { timeZone: data.timeZone });
	}

	function avatarText(name: string): string {
		return name.trim().slice(0, 1).toUpperCase() || '?';
	}

	/** Which timestamp a row shows: the tab decides what "time" means. */
	function rowTime(row: Row): Date | null {
		if (data.state === 'outdated') return row.lostSince;
		if (data.state === 'banned' || data.state === 'rejected') return row.reviewedAt;
		return row.createdAt;
	}

	/**
	 * Writable mirror of `?state=` for the filter group. `bind:` needs somewhere
	 * to write, and bits-ui's single-select toggle clears itself when the active
	 * item is clicked again - while a filter always has a state, so the group
	 * must snap straight back instead of showing nothing as selected.
	 */
	// eslint-disable-next-line svelte/prefer-writable-derived -- $derived is not bindable
	let filterValue = $state<string>(untrack(() => data.state));
	// Back/forward moves `?state=` without a click, so the mirror re-syncs.
	$effect(() => {
		filterValue = data.state;
	});

	// ── Flash / page error (projects-page pattern) ──
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
			case 'created':
				return m.admin_friends_flash_created();
			case 'updated':
				return m.admin_friends_flash_updated();
			case 'approved':
				return m.admin_friends_flash_approved();
			case 'rejected':
				return m.admin_friends_flash_rejected();
			case 'banned':
				return m.admin_friends_flash_banned();
			case 'restored':
				return m.admin_friends_flash_restored();
			case 'removed':
				return m.admin_friends_flash_removed();
			case 'purged':
				return m.admin_friends_flash_purged({
					count: Number('deleted' in form ? form.deleted : 0)
				});
			case 'check-queued':
				return m.admin_friends_flash_check_queued();
			case 'check-dedup':
				return m.admin_friends_flash_check_dedup();
			case 'checked':
				return m.admin_friends_flash_checked();
			case 'prechecked':
				return m.admin_friends_flash_prechecked();
			default:
				return null;
		}
	});

	// ── Forms ──
	let submitting = $state(false);
	let headerCheckForm = $state<HTMLFormElement | null>(null);
	let rowCheckForm = $state<HTMLFormElement | null>(null);
	let rowCheckId = $state<HTMLInputElement | null>(null);

	function closeOnSuccess(close: () => void): SubmitFunction {
		return () => {
			submitting = true;
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
		};
	}

	function checkNow(row: Row) {
		dismissError();
		if (!rowCheckForm || !rowCheckId) return;
		rowCheckForm.action = '?/checkOne';
		rowCheckId.value = row.id;
		rowCheckForm.requestSubmit();
	}

	// ── Dialog state ──
	let createOpen = $state(false);
	let editOpen = $state(false);
	let editing = $state<Row | null>(null);
	let approveRow = $state<Row | null>(null);
	let rejectRow = $state<Row | null>(null);
	let banRow = $state<Row | null>(null);
	let restoreRow = $state<Row | null>(null);
	let deleteTarget = $state<Row | null>(null);
	let purgeOpen = $state(false);
	let detailRow = $state<Row | null>(null);
	let detailOpen = $state(false);
	let prechecking = $state(false);
	let precheckError = $state<string | null>(null);

	/**
	 * The precheck action returns the fresh run so the drawer can show it
	 * immediately; the table refresh comes from `invalidateAll` (the row badge
	 * reads the same child table).
	 */
	const precheckSubmit: SubmitFunction = () => {
		prechecking = true;
		precheckError = null;
		return async ({ result, update }) => {
			prechecking = false;
			if (result.type === 'failure') {
				const data = result.data as { error?: string } | undefined;
				precheckError = data?.error ?? '';
				return;
			}
			if (result.type === 'success') {
				const data = result.data as { runs?: Row['prechecks'] } | undefined;
				if (detailRow && data?.runs?.length) {
					detailRow = {
						...detailRow,
						prechecks: [...data.runs, ...(detailRow.prechecks ?? [])]
					};
				}
				await update({ invalidateAll: true });
			}
		};
	};

	let fieldName = $state('');
	let fieldUrl = $state('');
	let fieldBacklink = $state('');
	let fieldAvatar = $state('');
	let fieldDescription = $state('');
	let fieldEmail = $state('');
	let fieldSort = $state(0);
	let fieldCheck = $state(true);
	let note = $state('');
	let reason = $state('');

	function resetFields() {
		fieldName = '';
		fieldUrl = '';
		fieldBacklink = '';
		fieldAvatar = '';
		fieldDescription = '';
		fieldEmail = '';
		fieldSort = 0;
		fieldCheck = true;
	}

	function openCreate() {
		dismissError();
		resetFields();
		createOpen = true;
	}

	function openEdit(row: Row) {
		dismissError();
		editing = row;
		fieldName = row.name;
		fieldUrl = row.url;
		fieldBacklink = row.backlinkUrl ?? '';
		fieldAvatar = row.avatar ?? '';
		fieldDescription = row.description ?? '';
		fieldEmail = row.email ?? '';
		fieldSort = row.sortOrder;
		fieldCheck = row.checkEnabled;
		editOpen = true;
	}

	function openApprove(row: Row) {
		dismissError();
		approveRow = row;
		note = '';
	}

	function openRestore(row: Row) {
		dismissError();
		restoreRow = row;
		note = '';
	}

	function openReject(row: Row) {
		dismissError();
		rejectRow = row;
		reason = '';
	}

	function openBan(row: Row) {
		dismissError();
		banRow = row;
		reason = '';
	}

	function openDetail(row: Row) {
		detailRow = row;
		detailOpen = true;
	}

	function openPurge() {
		dismissError();
		purgeOpen = true;
	}

	// ── Header actions (declared in +page.server.ts) ──
	const headerActions = useAdminHeaderActionRegistry();
	$effect(() => {
		if (!headerActions) return;
		const cleanups = [
			headerActions.register('friends:check', () => headerCheckForm?.requestSubmit()),
			headerActions.register('friends:create', openCreate)
		];
		return () => cleanups.forEach((cleanup) => cleanup());
	});
</script>

<svelte:head>
	<title>{m.admin_friends_title()} - Lair Admin</title>
</svelte:head>

{#snippet dialogError()}
	{#if errorMessage}
		<p role="alert" class="px-5 pt-3 text-sm text-destructive">{errorMessage}</p>
	{/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col">
	<!-- Hidden forms driven by the header / row menu (never visible). -->
	<form
		bind:this={headerCheckForm}
		method="post"
		action="?/checkAll"
		use:enhance={closeOnSuccess(() => {})}
		class="hidden"
	></form>
	<form
		bind:this={rowCheckForm}
		method="post"
		action="?/checkOne"
		use:enhance={closeOnSuccess(() => {})}
		class="hidden"
	>
		<input bind:this={rowCheckId} type="hidden" name="id" value="" />
	</form>

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

	<!-- State filter: same ToggleGroup as projects / comments (URL-driven). -->
	<nav
		class="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b px-4"
		aria-label={m.admin_friends_tab_aria()}
	>
		<ToggleGroup.Root
			type="single"
			bind:value={filterValue}
			onValueChange={(value) => {
				// A re-click clears the value: snap back, a filter always has a state.
				if (!value) {
					filterValue = data.state;
					return;
				}
				if (value !== data.state) {
					goto(`?state=${value}`, { keepFocus: true, noScroll: true });
				}
			}}
			variant="outline"
			size="sm"
			class="gap-1"
		>
			{#each STATES as state (state)}
				<ToggleGroup.Item value={state}>
					{STATE_TEXT[state]()}
					<span class="text-xs opacity-60">{data.counts.byStatus[state]}</span>
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
		{#if data.state === 'outdated' && data.counts.byStatus.outdated > 0}
			<Button
				variant="ghost"
				size="sm"
				class="ml-auto text-xs text-destructive"
				onclick={openPurge}
			>
				{m.admin_friends_purge_outdated()}
			</Button>
		{/if}
	</nav>

	{#await data.rows}
		<div class="grid gap-2 p-4">
			<Skeleton class="h-10 w-full" />
			<Skeleton class="h-10 w-full" />
			<Skeleton class="h-10 w-full" />
		</div>
	{:then rows}
		<ListTable
			{columns}
			{rows}
			rowKey={(row) => row.id}
			label={m.admin_friends_title()}
			class="min-h-96"
		>
			{#snippet row(friend)}
				<Table.Cell class={cn(listColumnClass(cols.name), 'whitespace-normal')}>
					<div class="flex min-w-0 items-center gap-3">
						<div
							class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
						>
							{avatarText(friend.name)}
						</div>
						<div class="min-w-0">
							<div class="flex min-w-0 items-center gap-1.5">
								<a
									class="flex min-w-0 items-center gap-1 font-medium hover:underline"
									href={friend.url}
									rel="noreferrer"
									target="_blank"
								>
									<span class="truncate">{friend.name}</span>
									<IconExternalLink class="size-3 shrink-0" aria-hidden="true" />
								</a>
								{#if friend.badges.precheck}
									{@const precheck = friend.badges.precheck}
									<Badge
										variant={precheck.status === 'running' || precheck.status === 'stale'
											? 'outline'
											: precheck.ok
												? 'secondary'
												: precheck.errorKind
													? 'destructive'
													: 'outline'}
										class="h-4.5 shrink-0 px-1.5 text-[10px]"
										title={fmt(precheck.at)}
									>
										{#if precheck.status === 'running'}
											{m.admin_friends_precheck_state_running()}
										{:else if precheck.status === 'stale'}
											{m.admin_friends_precheck_incomplete()}
										{:else if precheck.ok}
											{m.admin_friends_precheck_ok()}
										{:else if precheck.errorKind}
											{m.admin_friends_precheck_failed()} · {errorKindText(precheck.errorKind)}
										{:else}
											{m.admin_friends_precheck_incomplete()}
										{/if}
									</Badge>
								{/if}
							</div>
							<span class="block truncate text-xs text-muted-foreground">{friend.host}</span>
							{#if friend.description}
								<span class="line-clamp-1 text-xs text-muted-foreground">{friend.description}</span>
							{/if}
						</div>
					</div>
				</Table.Cell>

				<Table.Cell class={cn(listColumnClass(cols.backlink), 'whitespace-normal')}>
					{#if friend.backlinkOk === true}
						<span class="text-xs text-primary-text">{m.admin_friends_backlink_ok()}</span>
					{:else if friend.backlinkOk === false}
						<span class="text-xs text-destructive">
							{m.admin_friends_backlink_missing({ count: friend.backlinkMissingStreak })}
						</span>
					{:else}
						<span class="text-xs text-muted-foreground">{m.admin_friends_backlink_unknown()}</span>
					{/if}
					{#if friend.badges.backlinkLost}
						<span class="mt-0.5 block text-[10px] text-destructive">
							{m.admin_friends_badge_backlink_lost()}
						</span>
					{/if}
					<span class="mt-0.5 block text-[10px] text-muted-foreground">
						{fmt(friend.backlinkCheckedAt)}
					</span>
				</Table.Cell>

				<Table.Cell class={cn(listColumnClass(cols.health), 'whitespace-normal')}>
					{#if friend.lastErrorKind}
						<span class="text-xs text-destructive">{errorKindText(friend.lastErrorKind)}</span>
					{:else if friend.lastCheckedAt}
						<span class="text-xs text-muted-foreground">{m.admin_friends_health_ok()}</span>
					{:else}
						<span class="text-xs text-muted-foreground">{m.admin_friends_health_unknown()}</span>
					{/if}
					{#if friend.failStreak > 0}
						<span class="mt-0.5 block text-[10px] text-muted-foreground">
							{m.admin_friends_fail_streak({ count: friend.failStreak })}
						</span>
					{/if}
					{#if friend.badges.blocked}
						<span class="mt-0.5 block text-[10px] text-destructive">
							{m.admin_friends_badge_blocked()}
						</span>
					{/if}
				</Table.Cell>

				<Table.Cell class={cn(listColumnClass(cols.email), 'whitespace-normal')}>
					<span class="truncate text-xs text-muted-foreground">{friend.email ?? '—'}</span>
				</Table.Cell>

				<Table.Cell
					class={cn(listColumnClass(cols.time), 'text-xs whitespace-nowrap text-muted-foreground')}
				>
					<span>{fmt(rowTime(friend))}</span>
					{#if friend.badges.purgeSoon && friend.badges.daysToPurge !== null}
						<span class="mt-0.5 block text-[10px] text-destructive">
							{m.admin_friends_purge_in({ days: friend.badges.daysToPurge })}
						</span>
					{/if}
				</Table.Cell>

				<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
					<ListRowActions
						editLabel={friend.status === 'approved' || friend.status === 'outdated'
							? m.admin_common_edit()
							: undefined}
						onEdit={() => openEdit(friend)}
						deleteLabel={m.admin_friends_remove()}
						onDelete={() => (deleteTarget = friend)}
						moreLabel={m.admin_common_more()}
					>
						{#snippet primary()}
							{#if friend.status === 'pending'}
								<Button
									variant="ghost"
									size="sm"
									class="text-xs"
									onclick={() => openApprove(friend)}
								>
									{m.admin_friends_approve()}
								</Button>
							{:else if friend.status === 'banned'}
								<Button
									variant="ghost"
									size="sm"
									class="text-xs"
									onclick={() => openRestore(friend)}
								>
									{m.admin_friends_restore()}
								</Button>
							{:else if friend.status === 'rejected'}
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={m.admin_friends_details()}
									title={m.admin_friends_details()}
									onclick={() => openDetail(friend)}
								>
									<IconEye />
								</Button>
							{/if}
						{/snippet}
						{#snippet more()}
							<DropdownMenu.Item onclick={() => openDetail(friend)}>
								{m.admin_friends_details()}
							</DropdownMenu.Item>
							{#if friend.status === 'pending' || friend.status === 'approved' || friend.status === 'outdated'}
								<DropdownMenu.Item onclick={() => checkNow(friend)}>
									{m.admin_friends_check_now()}
								</DropdownMenu.Item>
							{/if}
							{#if friend.status === 'pending'}
								<DropdownMenu.Item onclick={() => openReject(friend)}>
									{m.admin_friends_reject()}
								</DropdownMenu.Item>
							{/if}
							{#if friend.status === 'approved' || friend.status === 'outdated'}
								<DropdownMenu.Item
									class="text-destructive focus:text-destructive"
									onclick={() => openBan(friend)}
								>
									{m.admin_friends_ban()}
								</DropdownMenu.Item>
							{/if}
							{#if friend.status === 'pending' || friend.status === 'rejected'}
								<DropdownMenu.Item onclick={() => openEdit(friend)}>
									{m.admin_common_edit()}
								</DropdownMenu.Item>
							{/if}
						{/snippet}
					</ListRowActions>
				</Table.Cell>
			{/snippet}

			{#snippet empty()}
				<Empty class="mx-auto py-14">
					<p class="text-sm text-muted-foreground">{m.admin_friends_empty()}</p>
				</Empty>
			{/snippet}

			{#snippet footer()}
				<div
					class="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground"
				>
					<span>{m.admin_common_count_entries({ count: data.counts.byStatus[data.state] })}</span>
					{#if data.counts.byStatus[data.state] > rows.length}
						<span>{m.admin_friends_limit_hint({ shown: rows.length })}</span>
					{/if}
				</div>
			{/snippet}
		</ListTable>
	{/await}
</div>

<!-- Create -->
<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form method="post" action="?/create" use:enhance={closeOnSuccess(() => (createOpen = false))}>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_add()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-4 px-5 py-4">
				<div class="grid gap-1.5">
					<label for="friend-name" class="text-sm font-medium">
						{m.admin_friends_field_name()}<span class="text-destructive"> *</span>
					</label>
					<Input id="friend-name" name="name" required bind:value={fieldName} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-url" class="text-sm font-medium">
						{m.admin_friends_field_url()}<span class="text-destructive"> *</span>
					</label>
					<Input id="friend-url" name="url" required placeholder="https://" bind:value={fieldUrl} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-backlink" class="text-sm font-medium">
						{m.admin_friends_field_backlink()}<span class="text-destructive"> *</span>
					</label>
					<Input id="friend-backlink" name="backlinkUrl" required bind:value={fieldBacklink} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-avatar" class="text-sm font-medium">
						{m.admin_friends_field_avatar()}
					</label>
					<Input id="friend-avatar" name="avatar" bind:value={fieldAvatar} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-desc" class="text-sm font-medium">
						{m.admin_friends_field_description()}
					</label>
					<Input id="friend-desc" name="description" bind:value={fieldDescription} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-email" class="text-sm font-medium">
						{m.admin_friends_field_email()}
					</label>
					<Input id="friend-email" name="email" type="email" bind:value={fieldEmail} />
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div class="grid gap-1.5">
						<label for="friend-sort" class="text-sm font-medium">
							{m.admin_friends_field_sort()}
						</label>
						<Input
							id="friend-sort"
							name="sortOrder"
							type="number"
							min="0"
							max="9999"
							bind:value={fieldSort}
						/>
					</div>
					<label class="flex items-center gap-2 self-end pb-2 text-sm">
						<input
							type="checkbox"
							name="checkEnabled"
							class="size-4 accent-primary"
							bind:checked={fieldCheck}
						/>
						{m.admin_friends_field_check_enabled()}
					</label>
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					disabled={submitting || !fieldName.trim() || !fieldUrl.trim() || !fieldBacklink.trim()}
				>
					{m.admin_common_confirm()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Edit -->
<Dialog.Root bind:open={editOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form method="post" action="?/update" use:enhance={closeOnSuccess(() => (editOpen = false))}>
			<input type="hidden" name="id" value={editing?.id ?? ''} />
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_edit_title()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-4 px-5 py-4">
				<div class="grid gap-1.5">
					<label for="edit-name" class="text-sm font-medium">{m.admin_friends_field_name()}</label>
					<Input id="edit-name" name="name" required bind:value={fieldName} />
				</div>
				<div class="grid gap-1.5">
					<label for="edit-url" class="text-sm font-medium">{m.admin_friends_field_url()}</label>
					<Input id="edit-url" name="url" required bind:value={fieldUrl} />
				</div>
				<div class="grid gap-1.5">
					<label for="edit-backlink" class="text-sm font-medium">
						{m.admin_friends_field_backlink()}
					</label>
					<Input id="edit-backlink" name="backlinkUrl" bind:value={fieldBacklink} />
				</div>
				<div class="grid gap-1.5">
					<label for="edit-avatar" class="text-sm font-medium"
						>{m.admin_friends_field_avatar()}</label
					>
					<Input id="edit-avatar" name="avatar" bind:value={fieldAvatar} />
				</div>
				<div class="grid gap-1.5">
					<label for="edit-desc" class="text-sm font-medium">
						{m.admin_friends_field_description()}
					</label>
					<Input id="edit-desc" name="description" bind:value={fieldDescription} />
				</div>
				<div class="grid gap-1.5">
					<label for="edit-email" class="text-sm font-medium">{m.admin_friends_field_email()}</label
					>
					<Input id="edit-email" name="email" type="email" bind:value={fieldEmail} />
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div class="grid gap-1.5">
						<label for="edit-sort" class="text-sm font-medium">{m.admin_friends_field_sort()}</label
						>
						<Input
							id="edit-sort"
							name="sortOrder"
							type="number"
							min="0"
							max="9999"
							bind:value={fieldSort}
						/>
					</div>
					<label class="flex items-center gap-2 self-end pb-2 text-sm">
						<input
							type="checkbox"
							name="checkEnabled"
							class="size-4 accent-primary"
							bind:checked={fieldCheck}
						/>
						{m.admin_friends_field_check_enabled()}
					</label>
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					disabled={submitting || !fieldName.trim() || !fieldUrl.trim()}
				>
					{m.admin_common_save()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Approve -->
<Dialog.Root
	open={approveRow !== null}
	onOpenChange={(value) => (approveRow = value ? approveRow : null)}
>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<form method="post" action="?/approve" use:enhance={closeOnSuccess(() => (approveRow = null))}>
			<input type="hidden" name="id" value={approveRow?.id ?? ''} />
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_approve()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-sm text-muted-foreground">
					{approveRow?.name} · {approveRow?.host}
				</p>
				{#if approveRow && approveRow.backlinkOk !== true}
					<p class="text-xs text-destructive">{m.admin_friends_override_hint()}</p>
				{/if}
				<div class="grid gap-1.5">
					<label for="approve-note" class="text-sm font-medium">{m.admin_friends_note()}</label>
					<Textarea id="approve-note" name="note" rows={3} bind:value={note} />
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					disabled={submitting || (approveRow?.backlinkOk !== true && note.trim() === '')}
				>
					{m.admin_common_confirm()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Reject -->
<Dialog.Root
	open={rejectRow !== null}
	onOpenChange={(value) => (rejectRow = value ? rejectRow : null)}
>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<form method="post" action="?/reject" use:enhance={closeOnSuccess(() => (rejectRow = null))}>
			<input type="hidden" name="id" value={rejectRow?.id ?? ''} />
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_reject()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-sm text-muted-foreground">{rejectRow?.name} · {rejectRow?.host}</p>
				<div class="grid gap-1.5">
					<label for="reject-reason" class="text-sm font-medium">
						{m.admin_friends_reason()}<span class="text-destructive"> *</span>
					</label>
					<Textarea id="reject-reason" name="reason" rows={3} bind:value={reason} />
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					variant="destructive"
					disabled={submitting || reason.trim() === ''}
				>
					{m.admin_common_confirm()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Ban -->
<Dialog.Root open={banRow !== null} onOpenChange={(value) => (banRow = value ? banRow : null)}>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<form method="post" action="?/ban" use:enhance={closeOnSuccess(() => (banRow = null))}>
			<input type="hidden" name="id" value={banRow?.id ?? ''} />
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_ban()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-sm text-muted-foreground">{banRow?.name} · {banRow?.host}</p>
				<p class="text-xs text-muted-foreground">{m.admin_friends_ban_warning()}</p>
				<div class="grid gap-1.5">
					<label for="ban-reason" class="text-sm font-medium">
						{m.admin_friends_reason()}<span class="text-destructive"> *</span>
					</label>
					<Textarea id="ban-reason" name="reason" rows={3} bind:value={reason} />
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					variant="destructive"
					disabled={submitting || reason.trim() === ''}
				>
					{m.admin_common_confirm()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Restore -->
<Dialog.Root
	open={restoreRow !== null}
	onOpenChange={(value) => (restoreRow = value ? restoreRow : null)}
>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<form method="post" action="?/restore" use:enhance={closeOnSuccess(() => (restoreRow = null))}>
			<input type="hidden" name="id" value={restoreRow?.id ?? ''} />
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_restore()}</Dialog.Title>
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
			{@render dialogError()}
			<div class="grid gap-3 px-5 py-4">
				<p class="text-sm text-muted-foreground">{restoreRow?.name} · {restoreRow?.host}</p>
				<p class="text-xs text-muted-foreground">{m.admin_friends_restore_warning()}</p>
				{#if restoreRow && restoreRow.backlinkOk !== true}
					<p class="text-xs text-destructive">{m.admin_friends_override_hint()}</p>
				{/if}
				<div class="grid gap-1.5">
					<label for="restore-note" class="text-sm font-medium">{m.admin_friends_note()}</label>
					<Textarea id="restore-note" name="note" rows={3} bind:value={note} />
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					type="submit"
					size="sm"
					disabled={submitting || (restoreRow?.backlinkOk !== true && note.trim() === '')}
				>
					{m.admin_common_confirm()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Detail -->
<Sheet.Root bind:open={detailOpen}>
	<Sheet.Portal>
		<Sheet.Overlay />
		<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-md">
			<Sheet.Header>
				<Sheet.Title>{detailRow?.name ?? ''}</Sheet.Title>
				<Sheet.Description>
					{STATE_TEXT[detailRow?.status ?? '']?.() ?? ''} · {detailRow?.host ?? ''}
				</Sheet.Description>
				<Sheet.Close>
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
				</Sheet.Close>
			</Sheet.Header>

			{#if detailRow}
				<section class="grid gap-2 border-b px-4 py-3">
					<h3 class="text-xs font-medium text-muted-foreground">
						{m.admin_friends_detail_basic()}
					</h3>
					<dl class="grid gap-1 text-sm">
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_url()}</dt>
							<dd class="min-w-0 truncate">
								<a class="hover:underline" href={detailRow.url} target="_blank" rel="noreferrer">
									{detailRow.url}
								</a>
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_email()}</dt>
							<dd class="truncate">{detailRow.email ?? '—'}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_description()}</dt>
							<dd class="min-w-0 truncate">{detailRow.description ?? '—'}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_sort()}</dt>
							<dd>{detailRow.sortOrder}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_check_enabled()}</dt>
							<dd>
								{detailRow.checkEnabled ? m.admin_common_enable() : m.admin_common_disable()}
							</dd>
						</div>
					</dl>
				</section>

				<section class="grid gap-2 border-b px-4 py-3">
					<h3 class="text-xs font-medium text-muted-foreground">
						{m.admin_friends_detail_backlink()}
					</h3>
					<dl class="grid gap-1 text-sm">
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_field_backlink()}</dt>
							<dd class="min-w-0 truncate">
								{#if detailRow.backlinkUrl}
									<a
										class="hover:underline"
										href={detailRow.backlinkUrl}
										target="_blank"
										rel="noreferrer"
									>
										{detailRow.backlinkUrl}
									</a>
								{:else}
									—
								{/if}
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_col_backlink()}</dt>
							<dd>
								{#if detailRow.backlinkOk === true}
									{m.admin_friends_backlink_ok()}
								{:else if detailRow.backlinkOk === false}
									{m.admin_friends_backlink_missing({ count: detailRow.backlinkMissingStreak })}
								{:else}
									{m.admin_friends_backlink_unknown()}
								{/if}
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_detail_backlink_checked()}</dt>
							<dd>{fmt(detailRow.backlinkCheckedAt)}</dd>
						</div>
					</dl>
				</section>

				<section class="grid gap-2 border-b px-4 py-3">
					<h3 class="text-xs font-medium text-muted-foreground">
						{m.admin_friends_detail_health()}
					</h3>
					<dl class="grid gap-1 text-sm">
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_detail_checked_at()}</dt>
							<dd>{fmt(detailRow.lastCheckedAt)}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_detail_ok_at()}</dt>
							<dd>{fmt(detailRow.lastOkAt)}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_detail_error_kind()}</dt>
							<dd>
								{#if detailRow.lastErrorKind}
									{errorKindText(detailRow.lastErrorKind)}
									<span class="ml-1 font-mono text-xs text-muted-foreground"
										>{detailRow.lastErrorKind}</span
									>
								{:else}
									—
								{/if}
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">
								{m.admin_friends_detail_fail_streak()}
							</dt>
							<dd>{detailRow.failStreak}</dd>
						</div>
						{#if detailRow.lostSince}
							<div class="flex justify-between gap-3">
								<dt class="text-muted-foreground">{m.admin_friends_detail_lost_since()}</dt>
								<dd>{fmt(detailRow.lostSince)}</dd>
							</div>
						{/if}
					</dl>
				</section>

				<section class="grid gap-2 border-b px-4 py-3">
					<h3 class="text-xs font-medium text-muted-foreground">
						{m.admin_friends_detail_review()}
					</h3>
					<dl class="grid gap-1 text-sm">
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_friends_detail_checked_at()}</dt>
							<dd>{fmt(detailRow.reviewedAt)}</dd>
						</div>
						{#if detailRow.reason}
							<div class="grid gap-1">
								<dt class="text-muted-foreground">
									{detailRow.status === 'approved'
										? m.admin_friends_detail_override_note()
										: m.admin_friends_reason()}
								</dt>
								<dd class="text-sm break-words whitespace-pre-wrap">{detailRow.reason}</dd>
							</div>
						{/if}
					</dl>
				</section>

				{#if detailRow.status === 'pending'}
					<section class="grid gap-2 border-b px-4 py-3">
						<div class="flex items-start justify-between gap-2">
							<div class="grid gap-0.5">
								<h3 class="text-xs font-medium text-muted-foreground">
									{m.admin_friends_precheck_runs()}
								</h3>
								<p class="text-[11px] text-muted-foreground">
									{m.admin_friends_precheck_hint()}
								</p>
							</div>
							<form method="post" action="?/precheckOne" use:enhance={precheckSubmit}>
								<input type="hidden" name="id" value={detailRow.id} />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									class="h-7 shrink-0 text-xs"
									disabled={prechecking}
									aria-busy={prechecking}
								>
									{#if prechecking}<Spinner data-icon="inline-start" />{/if}
									{prechecking
										? m.admin_friends_precheck_running()
										: m.admin_friends_precheck_now()}
								</Button>
							</form>
						</div>
						{#if precheckError}
							<p role="alert" class="text-xs text-destructive">{precheckError}</p>
						{/if}
						{#if (detailRow.prechecks ?? []).length === 0}
							<p class="text-xs text-muted-foreground">
								{m.admin_friends_precheck_runs_empty()}
							</p>
						{:else}
							<ul class="grid gap-2">
								{#each detailRow.prechecks ?? [] as run, index (run.id ?? index)}
									<li class="grid gap-0.5 rounded-sm border px-2 py-1.5 text-xs">
										<div class="flex flex-wrap items-center gap-2">
											<span class="font-mono text-[10px] text-muted-foreground">{run.trigger}</span>
											{#if run.status === 'running'}
												<span class="text-muted-foreground">
													{m.admin_friends_precheck_state_running()}
												</span>
											{:else if run.status === 'stale'}
												<span class="text-destructive">
													{m.admin_friends_precheck_incomplete()}
												</span>
											{:else if run.ok}
												<span class="text-primary-text">{m.admin_friends_precheck_ok()}</span>
											{:else}
												<span class="text-destructive">
													{m.admin_friends_precheck_failed()}{run.errorKind
														? ` · ${errorKindText(run.errorKind)}`
														: ''}
												</span>
											{/if}
											{#if run.durationMs !== null}
												<span class="text-muted-foreground">{run.durationMs}ms</span>
											{/if}
											<span class="ml-auto text-muted-foreground">{fmt(run.startedAt)}</span>
										</div>
										{#if run.note}
											<p class="break-words text-muted-foreground">{run.note}</p>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				<section class="grid gap-2 px-4 py-3">
					<h3 class="text-xs font-medium text-muted-foreground">
						{m.admin_friends_detail_checks()}
					</h3>
					{#if (detailRow.recentChecks ?? []).length === 0}
						<p class="text-xs text-muted-foreground">{m.admin_friends_detail_checks_empty()}</p>
					{:else}
						<ul class="grid gap-2">
							{#each detailRow.recentChecks ?? [] as entry, index (index)}
								<li class="grid gap-0.5 rounded-sm border px-2 py-1.5 text-xs">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-[10px] text-muted-foreground">{entry.kind}</span>
										{#if entry.ok}
											<span class="text-primary-text">{m.admin_friends_health_ok()}</span>
										{:else}
											<span class="text-destructive">{errorKindText(entry.err) || entry.err}</span>
										{/if}
										{#if entry.http !== undefined}
											<span class="text-muted-foreground">HTTP {entry.http}</span>
										{/if}
										{#if entry.ms !== undefined}
											<span class="text-muted-foreground">{entry.ms}ms</span>
										{/if}
										<span class="ml-auto text-muted-foreground">{fmt(entry.at)}</span>
									</div>
									{#if entry.note}
										<p class="break-words text-muted-foreground">{entry.note}</p>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		</Sheet.Content>
	</Sheet.Portal>
</Sheet.Root>

<!-- Remove one row -->
<DeleteConfirm
	open={deleteTarget !== null}
	title={m.admin_friends_remove()}
	description={`${deleteTarget?.name ?? ''} · ${deleteTarget?.host ?? ''} — ${m.admin_friends_remove_warning()}`}
	id={deleteTarget?.id ?? ''}
	action="?/remove"
	error={errorMessage}
	onclose={() => (deleteTarget = null)}
/>

<!-- Purge every outdated row -->
<AlertDialog.Root bind:open={purgeOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_friends_purge_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_friends_purge_confirm({ count: data.counts.byStatus.outdated })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="post"
				action="?/purgeOutdated"
				use:enhance={closeOnSuccess(() => (purgeOpen = false))}
			>
				<Button type="submit" variant="destructive" disabled={submitting}>
					{m.admin_friends_purge_outdated()}
				</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

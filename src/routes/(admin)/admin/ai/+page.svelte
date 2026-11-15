<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Pathname } from '$app/types';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import * as Empty from '$lib/components/ui/empty';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Table from '$lib/components/ui/table';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as Trace from '$lib/components/ui/trace';
	import { ListFilter, ListTable, listColumnClass } from '$lib/components/admin/list-table';
	import { DeleteConfirm } from '$lib/components/admin';
	import { AI_FUNCTIONS, AI_FUNCTION_LABELS, type AiReadinessStatus } from '$lib/utils/ai-meta';
	import { readinessCopy } from '$lib/utils/readiness-copy';
	import {
		LEDGER_RANGES,
		LEDGER_STATUSES,
		LEDGER_TASKS,
		formatCost,
		formatNumber,
		formatStamp,
		ledgerSearch,
		relatedHref,
		type LedgerFilters
	} from '$lib/components/admin/ai/console-view';
	import { cols, columns } from './columns';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconCircleCheck from '@tabler/icons-svelte-runes/icons/circle-check';
	import IconMinus from '@tabler/icons-svelte-runes/icons/minus';
	import IconTrashX from '@tabler/icons-svelte-runes/icons/trash-x';

	let { data, form }: PageProps = $props();

	const locale = getLocale();
	const LIST_PATH: Pathname = '/admin/ai';

	/** Owner-only ledger wipe; the dialog owns the confirmation copy. */
	let purgeOpen = $state(false);

	const selected = $derived(data.rows.find((row) => row.id === data.openRow) ?? null);

	/** Share of the monthly cap spent. Uncapped months draw no meter. */
	const meterPct = $derived(
		data.budget.monthly > 0
			? Math.min(100, Math.round((data.budget.spent / data.budget.monthly) * 100))
			: 0
	);

	const readinessList = $derived(AI_FUNCTIONS.map((fn) => ({ fn, readiness: data.readiness[fn] })));

	function search(patch: Partial<LedgerFilters>): string {
		return ledgerSearch({ ...data.filters, ...patch });
	}

	function taskLabel(task: string): string {
		if (task === 'transcription') return m.admin_ai_transcribe_action();
		const labels = AI_FUNCTION_LABELS as Partial<Record<string, Record<string, string>>>;
		return labels[task]?.[locale] ?? task;
	}

	function statusLabel(status: string): string {
		return status === 'success' ? m.admin_ai_status_success() : m.admin_ai_status_failure();
	}

	/** Trace renders `error` in the destructive tone and `pending` at 60%. */
	function traceStatus(status: AiReadinessStatus): 'running' | 'error' | 'pending' | undefined {
		if (status === 'ready') return undefined;
		return status === 'not_wired' ? 'pending' : 'error';
	}

	const taskOptions = $derived([
		{ value: '', label: m.admin_common_all(), search: search({ task: '' }) },
		...LEDGER_TASKS.filter((task) => data.taskOptions.includes(task)).map((task) => ({
			value: task,
			label: taskLabel(task),
			search: search({ task })
		}))
	]);

	const statusOptions = $derived([
		{ value: '', label: m.admin_common_all(), search: search({ status: '' }) },
		...LEDGER_STATUSES.map((status) => ({
			value: status,
			label: statusLabel(status),
			search: search({ status })
		}))
	]);

	const providerOptions = $derived([
		{ value: '', label: m.admin_common_all(), search: search({ provider: '' }) },
		...data.providerOptions.map((provider) => ({
			value: provider,
			label: provider,
			search: search({ provider })
		}))
	]);

	// `ListFilter` replaces the visible column label with this string, so the
	// unfiltered state has to *be* the label: three identical "all" pills say
	// nothing about which column each one filters. Once a filter is on, the
	// value takes over - the same trade-off the other admin lists make.
	const currentTask = $derived(
		data.filters.task ? taskLabel(data.filters.task) : m.admin_ai_col_task()
	);
	const currentStatus = $derived(
		data.filters.status ? statusLabel(data.filters.status) : m.admin_common_status()
	);
	const currentProvider = $derived(data.filters.provider || m.admin_ai_col_model());

	/** Paraglide exposes static keys only, so ranges are a closed record. */
	const rangeLabels: Record<(typeof LEDGER_RANGES)[number], () => string> = {
		'7d': m.admin_ai_range_7d,
		'30d': m.admin_ai_range_30d,
		'90d': m.admin_ai_range_90d,
		all: m.admin_ai_range_all
	};

	/** Detail sheet rows, in the order they are read. */
	const detailRows = $derived(
		selected
			? [
					[m.admin_ai_col_task(), taskLabel(selected.task)] as [string, string],
					[m.admin_ai_detail_provider(), `${selected.provider} · ${selected.model}`] as [
						string,
						string
					],
					[m.admin_common_status(), statusLabel(selected.status)] as [string, string],
					[
						m.admin_ai_col_tokens(),
						`${m.admin_ai_col_tokens_in()} ${formatNumber(selected.inputTokens)} · ${m.admin_ai_col_tokens_out()} ${formatNumber(selected.outputTokens)}`
					] as [string, string],
					[
						m.admin_ai_col_duration(),
						selected.durationMs === null ? '—' : `${(selected.durationMs / 1000).toFixed(1)}s`
					] as [string, string],
					...(selected.task === 'transcription'
						? ([
								[
									m.admin_ai_col_audio_seconds(),
									selected.audioSeconds === null ? '—' : `${selected.audioSeconds}s`
								] as [string, string]
							] as [string, string][])
						: []),
					[
						m.admin_ai_col_cost(),
						formatCost(selected.costEstimate === null ? null : Number(selected.costEstimate))
					] as [string, string]
				]
			: []
	);
</script>

<svelte:head>
	<title>{m.admin_ai_title()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background">
	<!-- View + range. One flat row, bare controls - no boxed chrome. -->
	<div class="flex h-10 shrink-0 items-center gap-2 border-b px-4">
		<ToggleGroup.Root
			type="single"
			aria-label={m.admin_ai_view_label()}
			value={data.filters.view}
			onValueChange={(value) => {
				if (value && value !== data.filters.view) {
					goto(search({ view: value as LedgerFilters['view'] }), {
						keepFocus: true,
						noScroll: true
					});
				}
			}}
			variant="outline"
			size="sm"
			class="gap-1"
		>
			<ToggleGroup.Item
				value="activity"
				aria-current={data.filters.view === 'activity' ? 'true' : undefined}
			>
				{m.admin_ai_view_activity()}
			</ToggleGroup.Item>
			<ToggleGroup.Item
				value="summary"
				aria-current={data.filters.view === 'summary' ? 'true' : undefined}
			>
				{m.admin_ai_view_summary()}
			</ToggleGroup.Item>
		</ToggleGroup.Root>

		<ToggleGroup.Root
			type="single"
			aria-label={m.admin_ai_range_label()}
			value={data.filters.range}
			onValueChange={(value) => {
				if (value && value !== data.filters.range) {
					goto(search({ range: value as LedgerFilters['range'] }), {
						keepFocus: true,
						noScroll: true
					});
				}
			}}
			variant="outline"
			size="sm"
			class="gap-1"
		>
			{#each LEDGER_RANGES as range (range)}
				<ToggleGroup.Item value={range}>{rangeLabels[range]()}</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		{#if data.canPurge}
			<!-- Housekeeping for the whole ledger, not for the current filter: the
			     dialog says "all", so a narrowed range cannot make it read as scoped. -->
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="ml-auto text-muted-foreground hover:text-destructive"
				onclick={() => (purgeOpen = true)}
			>
				<IconTrashX data-icon="inline-start" />
				{m.admin_ai_purge()}
			</Button>
		{/if}
	</div>

	{#if form?.message}
		<p
			role="status"
			class="mx-4 mb-2 shrink-0 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
		>
			{form.message}
		</p>
	{/if}

	<!-- Budget. The only accent on this screen: one rule and one figure. -->
	<div class="flex h-10 shrink-0 items-center gap-3 border-b px-4">
		<span class="shrink-0 text-xs text-muted-foreground">{m.admin_ai_budget_month()}</span>
		<span class="shrink-0 text-sm tabular-nums">
			{formatCost(data.budget.spent)}
			<span class="text-xs text-muted-foreground">{data.budget.currency}</span>
			<span class="text-muted-foreground">/</span>
			{data.budget.monthly > 0 ? formatCost(data.budget.monthly) : m.admin_ai_no_limit()}
		</span>
		{#if data.budget.monthly > 0}
			<Progress value={meterPct} class="min-w-0 flex-1" aria-label={m.admin_ai_budget_month()} />
			<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{meterPct}%</span>
		{:else}
			<span class="min-w-0 flex-1"></span>
		{/if}
		{#if data.budget.unpricedCalls > 0}
			<span class="shrink-0 text-xs text-muted-foreground">
				{m.admin_ai_budget_unpriced({ count: data.budget.unpricedCalls })}
			</span>
			<Button variant="outline" size="sm" href="/admin/settings/ai#cost">
				{m.admin_ai_fix_pricing()}
			</Button>
		{/if}
		{#if data.budget.paused}
			<span class="shrink-0 text-xs text-destructive">{m.admin_ai_budget_paused()}</span>
		{/if}
		{#if data.filters.relatedType && data.filters.relatedId}
			<!-- A scoped ledger is the editor's "what did this cost" view. Without a
			     visible tag the tables look mysteriously empty, and there is no way
			     back to the full ledger that does not involve editing the URL. -->
			<span
				class="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs"
				data-testid="ledger-related-scope"
			>
				{m.admin_ai_scope_related({
					kind:
						data.filters.relatedType === 'post' ? m.admin_ai_scope_post() : m.admin_ai_scope_note()
				})}
				<a
					href={search({ relatedType: '', relatedId: '' })}
					class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					{m.admin_ai_scope_clear()}
				</a>
			</span>
		{/if}
	</div>

	<!-- Readiness. One trace line per function slot, shared copy with settings
	     and the editors, so a green light here is the same green light there. -->
	<div class="flex min-h-10 shrink-0 items-center gap-3 border-b px-4">
		<span class="shrink-0 text-xs text-muted-foreground">{m.admin_ai_readiness()}</span>
		<Trace.Root class="min-w-0 flex-1 flex-row flex-wrap gap-x-5 gap-y-1">
			{#each readinessList as item (item.fn)}
				{@const copy = readinessCopy(item.readiness.status, { name: item.readiness.envName ?? '' })}
				{@const href = item.readiness.fix?.href}
				{#if href}
					<a {href} class="min-w-0">
						<Trace.Line status={traceStatus(item.readiness.status)}>
							<Trace.Icon><IconAlertTriangle /></Trace.Icon>
							<Trace.Title>{AI_FUNCTION_LABELS[item.fn][locale]}</Trace.Title>
							<Trace.Description>{copy.hint}</Trace.Description>
						</Trace.Line>
					</a>
				{:else}
					<Trace.Line status={traceStatus(item.readiness.status)}>
						<Trace.Icon>
							{#if item.readiness.status === 'ready'}
								<IconCircleCheck />
							{:else}
								<IconMinus />
							{/if}
						</Trace.Icon>
						<Trace.Title>{AI_FUNCTION_LABELS[item.fn][locale]}</Trace.Title>
						<Trace.Description>{copy.hint}</Trace.Description>
					</Trace.Line>
				{/if}
			{/each}
		</Trace.Root>
	</div>

	{#if data.filters.view === 'summary'}
		<!-- Roll-up. Deliberately a table, not a second chart: the activity
		     ledger is the thing this page is about. -->
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.summary.length === 0}
				<div class="flex h-full items-center justify-center p-4">
					<Empty.Root class="max-w-md">
						<Empty.Header>
							<Empty.Title>{m.admin_ai_ledger_empty()}</Empty.Title>
							<Empty.Description>{m.admin_ai_ledger_empty_desc()}</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row class="border-b hover:bg-transparent">
							<Table.Head class="h-10 text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_month()}</Table.Head
							>
							<Table.Head class="h-10 text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_task()}</Table.Head
							>
							<Table.Head class="h-10 text-xs font-normal text-muted-foreground"
								>{m.admin_ai_detail_provider()}</Table.Head
							>
							<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_calls()}</Table.Head
							>
							<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_tokens_in()}</Table.Head
							>
							<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_tokens_out()}</Table.Head
							>
							<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
								>{m.admin_ai_col_cost()}</Table.Head
							>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.summary as row (`${row.month}-${row.task}-${row.provider}`)}
							<Table.Row>
								<Table.Cell class="text-muted-foreground tabular-nums">{row.month}</Table.Cell>
								<Table.Cell>{taskLabel(row.task)}</Table.Cell>
								<Table.Cell class="text-muted-foreground">{row.provider}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{formatNumber(row.calls)}</Table.Cell>
								<Table.Cell class="text-right tabular-nums"
									>{formatNumber(row.inputTokens)}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums"
									>{formatNumber(row.outputTokens)}</Table.Cell
								>
								<Table.Cell class="text-right tabular-nums">{formatCost(row.cost)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>

				<!-- Cost attribution: same range, grouped by the actor stored on
				     each ledger row. Unattended jobs have no actor. -->
				<div class="px-4 pt-8 pb-6">
					<h3 class="mb-3 text-sm font-medium">{m.admin_ai_by_actor()}</h3>
					<Table.Root>
						<Table.Header>
							<Table.Row class="border-b hover:bg-transparent">
								<Table.Head class="h-10 text-xs font-normal text-muted-foreground"
									>{m.admin_ai_col_actor()}</Table.Head
								>
								<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
									>{m.admin_ai_col_calls()}</Table.Head
								>
								<Table.Head class="h-10 text-right text-xs font-normal text-muted-foreground"
									>{m.admin_ai_col_cost()}</Table.Head
								>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.byActor as row (row.actorId ?? 'system')}
								<Table.Row>
									<Table.Cell>{row.name ?? row.email ?? m.admin_ai_by_actor_system()}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{formatNumber(row.calls)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{formatCost(row.cost)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</div>
	{:else}
		<ListTable
			{columns}
			rows={data.rows}
			rowKey={(row) => row.id}
			label={m.admin_ai_title()}
			class="min-h-0 flex-1"
		>
			{#snippet header(col)}
				{#if col.id === 'task'}
					<ListFilter
						path={LIST_PATH}
						label={col.label}
						current={currentTask}
						selected={data.filters.task}
						options={taskOptions}
					/>
				{:else if col.id === 'model'}
					<ListFilter
						path={LIST_PATH}
						label={col.label}
						current={currentProvider}
						selected={data.filters.provider}
						options={providerOptions}
					/>
				{:else if col.id === 'status'}
					<ListFilter
						path={LIST_PATH}
						label={col.label}
						current={currentStatus}
						selected={data.filters.status}
						options={statusOptions}
					/>
				{/if}
			{/snippet}

			{#snippet empty()}
				<div class="flex min-h-64 items-center justify-center p-4">
					<Empty.Root class="max-w-md">
						<Empty.Header>
							<Empty.Title>{m.admin_ai_ledger_empty()}</Empty.Title>
							<Empty.Description>{m.admin_ai_ledger_empty_desc()}</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<div class="flex flex-wrap items-center justify-center gap-2">
								<Button size="sm" href="/admin/posts/edit">{m.admin_ai_go_write()}</Button>
								<Button variant="outline" size="sm" href="/admin/translations">
									{m.admin_ai_open_translations()}
								</Button>
							</div>
						</Empty.Content>
					</Empty.Root>
				</div>
			{/snippet}

			{#snippet row(row)}
				{@const href = relatedHref(row.relatedType, row.relatedId)}
				<Table.Cell class={cn(listColumnClass(cols.time), 'tabular-nums')}>
					<a
						href={ledgerSearch(data.filters, { row: row.id })}
						class="hover:text-primary"
						aria-label={`${m.admin_ai_detail_title()} ${formatStamp(row.createdAt)}`}
					>
						{formatStamp(row.createdAt)}
					</a>
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.task))}>{taskLabel(row.task)}</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.model))}>
					<span class="block truncate">
						<span class="text-muted-foreground">{row.provider}</span>
						<span class="text-muted-foreground"> · </span>
						{row.model}
					</span>
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.status))}>
					<span
						class={cn(
							'inline-flex items-center gap-1.5',
							row.status === 'failure' && 'text-destructive'
						)}
					>
						<span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
						{statusLabel(row.status)}
					</span>
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.related))}>
					{#if href}
						<a {href} class="block truncate hover:text-primary">
							{row.relatedTitle ?? row.relatedType}
						</a>
					{:else}
						<span class="block truncate text-muted-foreground">
							{row.relatedTitle ?? row.relatedType ?? '—'}
						</span>
					{/if}
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.tokens), 'tabular-nums')}>
					{formatNumber((row.inputTokens ?? 0) + (row.outputTokens ?? 0))}
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.duration), 'tabular-nums')}>
					{row.durationMs === null ? '—' : `${(row.durationMs / 1000).toFixed(1)}s`}
				</Table.Cell>
				<Table.Cell class={cn(listColumnClass(cols.cost), 'tabular-nums')}>
					{formatCost(row.costEstimate === null ? null : Number(row.costEstimate))}
				</Table.Cell>
			{/snippet}

			{#snippet footer()}
				<div
					class="flex h-10 items-center justify-between border-t px-4 text-xs text-muted-foreground"
				>
					<span class="tabular-nums"
						>{m.admin_common_count_entries({ count: data.rows.length })}</span
					>
					<span class="tabular-nums">
						{m.admin_ai_budget_month()}
						{formatCost(data.budget.spent)}
					</span>
				</div>
			{/snippet}
		</ListTable>
	{/if}
</div>

<!-- Row detail. Kept in the URL so a link to one call survives a reload. -->
<Sheet.Root
	open={selected !== null}
	onOpenChange={(open) => {
		if (!open) goto(ledgerSearch(data.filters), { keepFocus: true, noScroll: true });
	}}
>
	<Sheet.Content side="right" class="w-96">
		<Sheet.Header>
			<Sheet.Title>{m.admin_ai_detail_title()}</Sheet.Title>
			<Sheet.Description class="tabular-nums">{formatStamp(selected?.createdAt)}</Sheet.Description>
		</Sheet.Header>
		{#if selected}
			<div class="flex flex-col gap-4 px-4 pb-4">
				<dl class="flex flex-col gap-2 text-sm">
					{#each detailRows as entry (entry[0])}
						<div class="flex items-start gap-3">
							<dt class="w-20 shrink-0 text-xs text-muted-foreground">{entry[0]}</dt>
							<dd class="min-w-0 flex-1 wrap-break-word tabular-nums">{entry[1]}</dd>
						</div>
					{/each}
				</dl>

				<div class="flex items-start gap-3 text-sm">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">{m.admin_ai_col_related()}</span
					>
					{#if relatedHref(selected.relatedType, selected.relatedId)}
						<a
							href={relatedHref(selected.relatedType, selected.relatedId)}
							class="min-w-0 flex-1 truncate hover:text-primary"
						>
							{selected.relatedTitle ?? selected.relatedType}
						</a>
					{:else}
						<span class="min-w-0 flex-1 truncate text-muted-foreground">
							{selected.relatedTitle ?? selected.relatedType ?? '—'}
						</span>
					{/if}
				</div>

				<div class="flex flex-wrap items-center gap-2 border-t pt-4">
					<Button variant="outline" size="sm" href={search({ task: selected.task })}>
						{m.admin_ai_detail_view_all()}
					</Button>
					<Button variant="ghost" size="sm" href="/admin/settings/ai">
						{m.admin_ai_settings_link()}
					</Button>
				</div>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<DeleteConfirm
	open={purgeOpen}
	title={m.admin_ai_purge_confirm_title()}
	description={m.admin_ai_purge_confirm_desc()}
	id=""
	action="?/purgeUsage"
	confirmLabel={m.admin_ai_purge()}
	onclose={() => (purgeOpen = false)}
/>

<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { SvelteMap } from 'svelte/reactivity';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import {
		buildFilterQuery,
		maintenanceFlash,
		RUN_LABELS,
		RUN_STATUSES,
		typecheckLabel,
		typecheckVariant
	} from './maintenance-form-utils';
	import * as Empty from '$lib/components/ui/empty';

	/**
	 * /admin/maintenance (J-3, plan §5.7): scripts (registry ∪ user layer)
	 * with inline schedule management, the run ledger with filters, and the
	 * job/schedule audit trail. Copy resolves from the message catalog.
	 */

	let { data }: PageProps = $props();

	interface ActionForm {
		status?: number;
		error?: string;
		queued?: boolean;
		name?: string;
		deduplicated?: boolean;
		scheduleChanged?: boolean;
		scheduleAction?: string;
		enabled?: boolean;
		watermarkReset?: boolean;
	}

	const form = $derived(page.form as ActionForm | null | undefined);
	const flash = $derived(maintenanceFlash(form));

	/** Query suffix so schedule/run actions keep the active ledger filters
	 * (a bare `?/action` POST would otherwise reset them, review P3-20). */
	const filterQuery = $derived(buildFilterQuery(data.filters));

	const schedulesByJob = $derived.by(() => {
		const map = new SvelteMap<string, PageProps['data']['schedules']>();
		for (const row of data.schedules) {
			const list = map.get(row.job) ?? [];
			list.push(row);
			map.set(row.job, list);
		}
		return map;
	});

	function runVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'failed') return 'destructive';
		if (status === 'succeeded') return 'default';
		if (status === 'running') return 'secondary';
		return 'outline';
	}

	function runDuration(run: { startedAt: Date | null; finishedAt: Date | null }): string {
		if (!run.startedAt || !run.finishedAt) return '—';
		const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '—';
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}
</script>

<svelte:head>
	<title>{m.admin_nav_maintenance()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	{#if flash}
		<div
			class="rounded-lg border px-4 py-2 text-sm {flash.kind === 'error'
				? 'border-destructive/40 bg-destructive/10 text-destructive'
				: 'bg-muted/50 text-foreground'}"
			data-slot="maintenance-flash"
			role="status"
		>
			{flash.text}
		</div>
	{/if}

	<!-- ① 脚本（含调度 inline） -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-sm font-semibold">{m.admin_maintenance_scripts()}</h2>
			<div class="flex items-center gap-2">
				<span class="text-xs text-muted-foreground">
					{m.admin_maintenance_scripts_hint({ count: data.scripts.length })}
				</span>
				<Button variant="outline" size="sm" href="/admin/maintenance/new"
					>{m.admin_maintenance_new_script()}</Button
				>
			</div>
		</div>
		<div class="grid gap-4 lg:grid-cols-2">
			{#each data.scripts as script (script.name)}
				{@const rows = schedulesByJob.get(script.name) ?? []}
				<div class="min-w-0 rounded-xl border bg-background p-4" data-slot="script-card">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate font-mono text-sm font-semibold">{script.name}</span>
								<Badge variant="outline"
									>{script.source === 'user'
										? m.admin_maintenance_source_user()
										: m.admin_maintenance_source_builtin()}</Badge
								>
								{#if script.forked}<Badge variant="secondary">{m.admin_maintenance_forked()}</Badge
									>{/if}
								{#if script.hasUpdate}<Badge>{m.admin_maintenance_has_update()}</Badge>{/if}
								{#if script.dismissed}<Badge variant="outline"
										>{m.admin_maintenance_dismissed()}</Badge
									>{/if}
							</div>
							<p class="mt-1 line-clamp-2 text-xs text-muted-foreground">{script.description}</p>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<form method="POST" action={'?/run' + filterQuery}>
								<input type="hidden" name="name" value={script.name} />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									disabled={!script.manual}
									title={script.manual ? undefined : m.admin_maintenance_manual_blocked()}
								>
									{m.admin_maintenance_run_now()}
								</Button>
							</form>
							<Button
								variant="ghost"
								size="sm"
								href={`/admin/maintenance/${encodeURIComponent(script.name)}`}
							>
								{m.admin_common_edit()}
							</Button>
						</div>
					</div>

					<div class="mt-3 border-t pt-3">
						{#if rows.length === 0}
							<Empty.Root class="gap-1 border-0 p-3">
								<Empty.Description class="text-xs"
									>{m.admin_maintenance_no_schedule()}</Empty.Description
								>
							</Empty.Root>
						{:else}
							<ul class="space-y-2">
								{#each rows as sched (sched.id)}
									<li class="min-w-0 text-xs" data-slot="schedule-row">
										<div class="flex flex-wrap items-center gap-2">
											<code class="rounded bg-muted px-1.5 py-0.5 font-mono">{sched.cronExpr}</code>
											<span class="text-muted-foreground">{sched.tz}</span>
											<Badge variant={sched.isEnabled ? 'default' : 'outline'}>
												{sched.isEnabled ? m.admin_common_enable() : m.admin_common_disable()}
											</Badge>
											<span class="text-muted-foreground"
												>{m.admin_maintenance_water_level()}{sched.lastDueLabel ?? '—'}</span
											>
											<span class="ml-auto flex items-center gap-1">
												<form method="POST" action={'?/scheduleToggle' + filterQuery}>
													<input type="hidden" name="id" value={sched.id} />
													<input
														type="hidden"
														name="enabled"
														value={sched.isEnabled ? 'false' : 'true'}
													/>
													<Button type="submit" variant="ghost" size="sm">
														{sched.isEnabled ? m.admin_common_disable() : m.admin_common_enable()}
													</Button>
												</form>
												<form method="POST" action={'?/scheduleDelete' + filterQuery}>
													<input type="hidden" name="id" value={sched.id} />
													<Button type="submit" variant="ghost" size="sm" class="text-destructive">
														{m.admin_common_delete()}
													</Button>
												</form>
											</span>
										</div>
										<details>
											<summary class="mt-1 cursor-pointer text-muted-foreground select-none">
												{m.admin_maintenance_edit_schedule()}
											</summary>
											<form
												method="POST"
												action={'?/scheduleUpdate' + filterQuery}
												class="mt-2 flex flex-wrap items-end gap-2"
											>
												<input type="hidden" name="id" value={sched.id} />
												<label class="grid gap-1 text-xs text-muted-foreground">
													{m.admin_maintenance_cron()}
													<Input
														name="cron_expr"
														value={sched.cronExpr}
														class="h-8 w-44 font-mono text-xs"
													/>
												</label>
												<label class="grid gap-1 text-xs text-muted-foreground">
													{m.admin_maintenance_timezone()}
													<Input name="tz" value={sched.tz} class="h-8 w-44 text-xs" />
												</label>
												<Button type="submit" size="sm" variant="outline"
													>{m.admin_maintenance_save_schedule()}</Button
												>
											</form>
										</details>
									</li>
								{/each}
							</ul>
						{/if}
						<details class="mt-2">
							<summary class="cursor-pointer text-xs text-muted-foreground select-none">
								{m.admin_maintenance_add_schedule()}
							</summary>
							<form
								method="POST"
								action={'?/scheduleCreate' + filterQuery}
								class="mt-2 flex flex-wrap items-end gap-2"
							>
								<input type="hidden" name="job" value={script.name} />
								<label class="grid gap-1 text-xs text-muted-foreground">
									{m.admin_maintenance_cron()}
									<Input
										name="cron_expr"
										placeholder="0 4 * * *"
										class="h-8 w-44 font-mono text-xs"
									/>
								</label>
								<label class="grid gap-1 text-xs text-muted-foreground">
									{m.admin_maintenance_timezone()}
									<Input name="tz" value={data.siteTz} class="h-8 w-44 text-xs" />
								</label>
								<Button type="submit" size="sm" variant="outline">{m.admin_common_add()}</Button>
							</form>
						</details>
					</div>
					{#if script.scheduleHint}
						<p class="mt-2 text-[11px] text-muted-foreground">
							{m.admin_maintenance_suggested({ hint: script.scheduleHint })}
						</p>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<!-- ② 运行台账 -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-sm font-semibold">{m.admin_maintenance_ledger()}</h2>
			<div class="flex items-center gap-2">
				<form method="POST" action={'?/typecheck' + filterQuery}>
					<Button type="submit" variant="outline" size="sm"
						>{m.admin_maintenance_run_typecheck()}</Button
					>
				</form>
				<RefreshButton size="sm" onclick={() => invalidateAll()} />
			</div>
		</div>

		{#if data.typecheck}
			<div class="mb-3 rounded-lg border p-3 text-xs" data-slot="typecheck-summary">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{m.admin_maintenance_last_typecheck()}</span>
					<Badge variant={typecheckVariant(data.typecheck)}>
						{typecheckLabel(data.typecheck)}
					</Badge>
					<span class="text-muted-foreground">
						{data.typecheck.createdLabel} · {data.typecheck.summary?.files ??
							'—'}{m.admin_maintenance_tc_files()}{data.typecheck.summary?.errors ??
							'—'}{m.admin_maintenance_tc_errors()}{data.typecheck.summary?.timedOut
							? m.admin_maintenance_tc_timed_out()
							: ''}
					</span>
				</div>
				{#if data.typecheck.summary?.runnerError}
					<p class="mt-1 text-destructive">
						{m.admin_maintenance_runner_label()}{data.typecheck.summary.runnerError}
					</p>
				{/if}
				{#if data.typecheck.error}
					<p class="mt-1 text-destructive">
						{m.admin_maintenance_error_label()}{data.typecheck.error}
					</p>
				{/if}
				{#if (data.typecheck.summary?.issues ?? []).length > 0}
					{#each (data.typecheck.summary?.issues ?? []).slice(0, 10) as issue, index (index)}
						<p class="mt-1 font-mono text-[11px] break-all text-muted-foreground">
							{issue.file}{issue.line !== null
								? `:${issue.line}${issue.column !== null ? `:${issue.column}` : ''}`
								: ''} — {issue.message}
						</p>
					{/each}
					{#if (data.typecheck.summary?.issues ?? []).length > 10}
						<p class="mt-1 text-muted-foreground">
							{m.admin_maintenance_tc_issues({
								count: data.typecheck.summary?.issues?.length ?? 0
							})}
						</p>
					{/if}
				{/if}
			</div>
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">
				{m.admin_maintenance_tc_none()}
			</p>
		{/if}

		<form method="GET" class="mb-3 flex flex-wrap items-end gap-3">
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_maintenance_job()}
				<select name="job" class="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
					<option value="" selected={data.filters.job === ''}>{m.admin_media_filter_all()}</option>
					{#each data.scripts as script (script.name)}
						<option value={script.name} selected={data.filters.job === script.name}>
							{script.name}
						</option>
					{/each}
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				{m.admin_common_status()}
				<select
					name="status"
					class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
				>
					<option value="" selected={data.filters.status === ''}
						>{m.admin_media_filter_all()}</option
					>
					{#each RUN_STATUSES as status (status)}
						<option value={status} selected={data.filters.status === status}
							>{RUN_LABELS[status]?.() ?? status}</option
						>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="outline" size="sm">{m.admin_media_filter()}</Button>
			<Button variant="ghost" size="sm" href="/admin/maintenance">{m.admin_common_clear()}</Button>
		</form>

		{#if data.runs.length === 0}
			<Empty.Root class="gap-1 border-0 p-3">
				<Empty.Description class="text-xs">{m.admin_maintenance_no_runs()}</Empty.Description>
			</Empty.Root>
		{:else}
			<div class="overflow-x-auto rounded-lg border">
				<div class="min-w-[44rem]">
					{#each data.runs as run (run.id)}
						<details class="group border-b last:border-b-0" data-slot="run-row">
							<summary
								class="grid cursor-pointer grid-cols-[10rem_1fr_5rem_6rem_4.5rem_1.25rem] items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50"
								title={m.admin_maintenance_expand()}
							>
								<span class="truncate text-muted-foreground">{run.createdLabel}</span>
								<span class="truncate font-mono">{run.job}</span>
								<span class="text-muted-foreground">{run.trigger}</span>
								<Badge variant={runVariant(run.status)} class="w-fit">
									{RUN_LABELS[run.status]?.() ?? run.status}
								</Badge>
								<span class="text-right text-muted-foreground">{runDuration(run)}</span>
								<span
									aria-hidden="true"
									class="text-center text-muted-foreground transition-transform group-open:rotate-90"
									>▸</span
								>
							</summary>
							<div class="space-y-1 border-t bg-muted/30 px-3 py-2 text-[11px]">
								<p>
									{m.admin_maintenance_id_label()}<code class="break-all">{run.id}</code>
								</p>
								<p>
									{m.admin_maintenance_source_hash_label()}<code class="break-all"
										>{run.sourceHash ?? '—'}</code
									>
								</p>
								{#if run.result}
									<p>
										{m.admin_maintenance_result_label()}<code class="break-all"
											>{JSON.stringify(run.result)}</code
										>
									</p>
								{/if}
								{#if run.error}
									<p class="text-destructive">{m.admin_maintenance_error_label()}{run.error}</p>
								{/if}
							</div>
						</details>
					{/each}
				</div>
			</div>
		{/if}
		{#if data.runsTruncated}
			<p class="mt-2 text-xs text-muted-foreground">
				{m.admin_maintenance_runs_cap({ count: data.runPageSize })}
			</p>
		{/if}
	</section>

	<!-- ③ 审计 -->
	<section>
		<h2 class="mb-4 text-sm font-semibold">{m.admin_maintenance_audit()}</h2>
		{#if data.activities.length === 0}
			<Empty.Root class="gap-1 border-0 p-3">
				<Empty.Description class="text-xs">{m.admin_maintenance_no_audit()}</Empty.Description>
			</Empty.Root>
		{:else}
			<div class="overflow-x-auto rounded-lg border">
				<div class="min-w-[34rem]">
					{#each data.activities as activity (activity.id)}
						<div
							class="grid grid-cols-[10rem_12rem_1fr] items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0"
							data-slot="audit-row"
						>
							<span class="truncate text-muted-foreground">{activity.createdLabel}</span>
							<Badge variant="outline" class="w-fit">{activity.event}</Badge>
							<span class="truncate font-mono text-muted-foreground">
								{activity.payload ? JSON.stringify(activity.payload) : '—'}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		{#if data.auditTruncated}
			<p class="mt-2 text-xs text-muted-foreground">
				{m.admin_maintenance_audit_cap({ count: data.auditPageSize })}
			</p>
		{/if}
	</section>
</div>

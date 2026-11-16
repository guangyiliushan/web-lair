<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { formatDateTime, formatNumber } from '$lib/utils/i18n';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';

	let { data }: { data: PageData } = $props();

	const ranges = [
		{ key: '24h' as const, label: m.admin_analytics_range_24h() },
		{ key: '7d' as const, label: m.admin_analytics_range_7d() },
		{ key: '30d' as const, label: m.admin_analytics_range_30d() }
	];

	const summary = $derived(data.traffic?.summary ?? null);
	const peak = $derived(
		Math.max(1, ...(data.traffic?.series.map((point) => point.requests) ?? [0]))
	);
	const empty = $derived((data.traffic?.overview.requests ?? 0) === 0);

	function barHeight(value: number): string {
		return `${Math.max(value > 0 ? 2 : 0, Math.round((value / peak) * 100))}%`;
	}

	function count(value: number | undefined): string {
		return value === undefined ? '—' : formatNumber(value);
	}
</script>

<svelte:head>
	<title>{m.admin_analytics_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-6 p-4 sm:p-6 lg:p-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{m.admin_analytics_title()}</h1>
			<p class="text-sm text-muted-foreground">{m.admin_analytics_desc()}</p>
		</div>
		<nav class="flex items-center gap-1" aria-label={m.admin_analytics_range_label()}>
			{#each ranges as range (range.key)}
				<a
					href={`${resolve('/admin/analytics')}?range=${range.key}`}
					class="rounded-md border px-2.5 py-1 text-xs transition-colors {data.range === range.key
						? 'border-primary bg-primary/10 font-medium text-foreground'
						: 'border-border text-muted-foreground hover:bg-muted/50'}"
					aria-current={data.range === range.key ? 'page' : undefined}
				>
					{range.label}
				</a>
			{/each}
		</nav>
	</div>

	{#if !data.traffic}
		<Card.Root class="border-dashed">
			<div class="p-4">
				<p class="font-medium">{m.admin_analytics_unavailable_title()}</p>
				<p class="mt-1 text-sm text-muted-foreground">{m.admin_analytics_unavailable_hint()}</p>
			</div>
		</Card.Root>
	{/if}

	<!-- KPI strip: the first number is page requests, never raw Sentinel requests. -->
	<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
		<Card.Root class="py-0">
			<div class="p-4">
				<p class="text-xs tracking-wide text-muted-foreground uppercase">
					{m.admin_analytics_page_requests()}
				</p>
				<p class="mt-1 text-2xl font-bold">{count(summary?.pageRequests)}</p>
				<p class="mt-1 text-[11px] text-muted-foreground">
					{m.admin_analytics_page_requests_hint()}
				</p>
			</div>
		</Card.Root>
		<Card.Root class="py-0">
			<div class="p-4">
				<p class="text-xs tracking-wide text-muted-foreground uppercase">
					{m.admin_analytics_unique_visitors()}
				</p>
				<p class="mt-1 text-2xl font-bold">{count(data.traffic?.overview.uniqueVisitors)}</p>
				<p class="mt-1 text-[11px] text-muted-foreground">
					{m.admin_analytics_unique_visitors_hint()}
				</p>
			</div>
		</Card.Root>
		<Card.Root class="py-0">
			<div class="p-4">
				<p class="text-xs tracking-wide text-muted-foreground uppercase">
					{m.admin_analytics_not_found()}
				</p>
				<p class="mt-1 text-2xl font-bold">{count(summary?.notFoundRequests)}</p>
				<p class="mt-1 text-[11px] text-muted-foreground">
					{m.admin_analytics_not_found_hint()}
				</p>
			</div>
		</Card.Root>
		<Card.Root class="py-0">
			<div class="p-4">
				<p class="text-xs tracking-wide text-muted-foreground uppercase">
					{m.admin_analytics_p95()}
				</p>
				<p class="mt-1 text-2xl font-bold">
					{data.traffic
						? `${formatNumber(data.traffic.overview.p95, { maximumFractionDigits: 0 })} ms`
						: '—'}
				</p>
				<p class="mt-1 text-[11px] text-muted-foreground">{m.admin_analytics_p95_hint()}</p>
			</div>
		</Card.Root>
	</div>

	{#if data.traffic}
		{#if data.generatedAt}
			<p class="text-right text-[11px] text-muted-foreground">
				{m.admin_analytics_updated({ time: formatDateTime(new Date(data.generatedAt)) })}
			</p>
		{/if}

		{#if data.traffic.summary.pathsTruncated}
			<p class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
				{m.admin_analytics_truncated()}
			</p>
		{/if}

		{#if empty}
			<Card.Root class="border-dashed">
				<div class="p-4 text-sm text-muted-foreground">{m.admin_analytics_empty()}</div>
			</Card.Root>
		{/if}

		<!-- All-request series. Page-request totals above are filtered; this strip is not. -->
		<Card.Root class="py-0">
			<div class="p-4">
				<div class="mb-3 flex items-center justify-between gap-3">
					<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{m.admin_analytics_series()}
					</h2>
					<span class="text-[11px] text-muted-foreground">
						{m.admin_analytics_all_requests()}:
						{formatNumber(data.traffic.overview.requests)}
					</span>
				</div>
				<div class="flex h-16 items-end gap-0.5" role="img" aria-label={m.admin_analytics_series()}>
					{#each data.traffic.series as point (point.bucket)}
						<div
							class="min-w-0 flex-1 rounded-t-sm bg-primary/60"
							style:height={barHeight(point.requests)}
							title={`${formatNumber(point.requests)}`}
						></div>
					{/each}
				</div>
			</div>
		</Card.Root>

		<div class="grid gap-4 lg:grid-cols-2">
			<!-- Top page paths after the PV filter. -->
			<Card.Root class="py-0">
				<div class="p-4">
					<div class="mb-2">
						<h2 class="text-sm font-medium">{m.admin_analytics_top_pages()}</h2>
						<p class="text-[11px] text-muted-foreground">{m.admin_analytics_top_pages_hint()}</p>
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr
									class="border-b text-left text-[11px] tracking-wide text-muted-foreground uppercase"
								>
									<th class="py-1.5 pr-2 font-medium">{m.admin_analytics_col_path()}</th>
									<th class="py-1.5 pr-2 text-right font-medium">
										{m.admin_analytics_col_requests()}
									</th>
									<th class="py-1.5 pr-2 text-right font-medium">
										{m.admin_analytics_col_errors()}
									</th>
									<th class="py-1.5 text-right font-medium">{m.admin_analytics_col_p95()}</th>
								</tr>
							</thead>
							<tbody>
								{#each data.traffic.summary.topPages as row (row.path)}
									<tr class="border-b border-border/60 last:border-0">
										<td
											class="max-w-[22rem] truncate py-1.5 pr-2 font-mono text-xs"
											title={row.path}
										>
											{row.path}
										</td>
										<td class="py-1.5 pr-2 text-right">{formatNumber(row.requests)}</td>
										<td class="py-1.5 pr-2 text-right">{formatNumber(row.s4xx)}</td>
										<td class="py-1.5 text-right text-muted-foreground">
											{formatNumber(row.p95, { maximumFractionDigits: 0 })} ms
										</td>
									</tr>
								{:else}
									<tr><td colspan="4" class="py-3 text-sm text-muted-foreground">—</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			</Card.Root>

			<!-- Top 4xx pages. Sentinel exposes 4xx per path, not 404 per path. -->
			<Card.Root class="py-0">
				<div class="p-4">
					<div class="mb-2">
						<h2 class="text-sm font-medium">{m.admin_analytics_top_errors()}</h2>
						<p class="text-[11px] text-muted-foreground">{m.admin_analytics_top_errors_hint()}</p>
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr
									class="border-b text-left text-[11px] tracking-wide text-muted-foreground uppercase"
								>
									<th class="py-1.5 pr-2 font-medium">{m.admin_analytics_col_path()}</th>
									<th class="py-1.5 pr-2 text-right font-medium">
										{m.admin_analytics_col_errors()}
									</th>
									<th class="py-1.5 text-right font-medium">
										{m.admin_analytics_col_requests()}
									</th>
								</tr>
							</thead>
							<tbody>
								{#each data.traffic.summary.topErrorPaths as row (row.path)}
									<tr class="border-b border-border/60 last:border-0">
										<td
											class="max-w-[22rem] truncate py-1.5 pr-2 font-mono text-xs"
											title={row.path}
										>
											{row.path}
										</td>
										<td class="py-1.5 pr-2 text-right">{formatNumber(row.s4xx)}</td>
										<td class="py-1.5 text-right text-muted-foreground">
											{formatNumber(row.requests)}
										</td>
									</tr>
								{:else}
									<tr><td colspan="3" class="py-3 text-sm text-muted-foreground">—</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			</Card.Root>
		</div>

		<!-- Referrer/browser/device top-5 lists from the same dashboard read. -->
		<div class="grid gap-4 lg:grid-cols-3">
			{#each [{ title: m.admin_analytics_breakdown_referer(), rows: data.traffic.referers }, { title: m.admin_analytics_breakdown_browser(), rows: data.traffic.browsers }, { title: m.admin_analytics_breakdown_device(), rows: data.traffic.devices }] as panel (panel.title)}
				<Card.Root class="py-0">
					<div class="p-4">
						<h2 class="mb-2 text-sm font-medium">{panel.title}</h2>
						<ul class="space-y-1 text-sm">
							{#each panel.rows as row (row.value || '(direct)')}
								<li class="flex items-baseline justify-between gap-3">
									<span class="min-w-0 truncate text-xs" title={row.value}>
										{row.value || m.admin_analytics_direct()}
									</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{formatNumber(row.requests)}
									</span>
								</li>
							{:else}
								<li class="text-sm text-muted-foreground">—</li>
							{/each}
						</ul>
					</div>
				</Card.Root>
			{/each}
		</div>

		{#if data.traffic.attribution}
			<p class="text-right text-[11px] text-muted-foreground">{data.traffic.attribution}</p>
		{/if}
	{/if}
</div>

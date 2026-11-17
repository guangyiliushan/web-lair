<script lang="ts">
	import { BarChart } from 'layerchart';
	import { ChartContainer, type ChartConfig } from '$lib/components/ui/chart';
	import ChartCard from './chart-card.svelte';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import { formatNumber } from '$lib/utils/i18n';
	import { m } from '$lib/paraglide/messages';

	interface Point {
		bucket: string;
		total: number;
		approved: number;
	}

	interface Props {
		data: Point[];
		class?: string;
	}

	let { data, class: className }: Props = $props();

	// Approved / pending are two content states, not a status-colour pair, so
	// they take categorical slots rather than the reserved good/warning tokens.
	const config: ChartConfig = {
		approved: { label: m.admin_dashboard_legend_approved(), color: 'var(--chart-1)' },
		pending: { label: m.admin_dashboard_legend_pending(), color: 'var(--chart-2)' }
	};

	// Stack to the total: approved + pending == total, so the bar height is the
	// day's volume and the split reads as part-to-whole.
	const rows = $derived(
		data.map((d) => ({
			bucket: d.bucket,
			approved: d.approved,
			pending: Math.max(d.total - d.approved, 0)
		}))
	);

	const series = [
		{
			key: 'approved',
			label: m.admin_dashboard_legend_approved(),
			value: 'approved',
			color: 'var(--chart-1)'
		},
		{
			key: 'pending',
			label: m.admin_dashboard_legend_pending(),
			value: 'pending',
			color: 'var(--chart-2)'
		}
	];

	const hasData = $derived(rows.some((d) => d.approved > 0 || d.pending > 0));
</script>

<ChartCard
	title={m.admin_dashboard_chart_comments_title()}
	description={m.admin_dashboard_chart_comments_desc()}
	icon={IconChartBar}
	empty={!hasData}
	class={className}
>
	<ul class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
		<li class="flex items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-xs bg-chart-1" aria-hidden="true"></span>
			<span>{m.admin_dashboard_legend_approved()}</span>
		</li>
		<li class="flex items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-xs bg-chart-2" aria-hidden="true"></span>
			<span>{m.admin_dashboard_legend_pending()}</span>
		</li>
	</ul>

	<ChartContainer {config} class="aspect-auto h-45 w-full">
		<BarChart data={rows} {series} seriesLayout="stack" x="bucket" />
	</ChartContainer>

	{#snippet table()}
		<table class="w-full text-xs">
			<caption class="sr-only">{m.admin_dashboard_chart_comments_title()}</caption>
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th scope="col" class="py-1 pr-3 font-medium">{m.admin_dashboard_col_date()}</th>
					<th scope="col" class="py-1 pr-3 text-right font-medium">
						{m.admin_dashboard_legend_approved()}
					</th>
					<th scope="col" class="py-1 text-right font-medium">
						{m.admin_dashboard_legend_pending()}
					</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.bucket)}
					<tr class="border-b border-border/50 last:border-0">
						<td class="py-1 pr-3 tabular-nums">{row.bucket}</td>
						<td class="py-1 pr-3 text-right tabular-nums">{formatNumber(row.approved)}</td>
						<td class="py-1 text-right tabular-nums">{formatNumber(row.pending)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/snippet}
</ChartCard>

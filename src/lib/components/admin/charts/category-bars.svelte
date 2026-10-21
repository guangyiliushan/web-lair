<script lang="ts">
	import { BarChart } from 'layerchart';
	import { ChartContainer, type ChartConfig } from '$lib/components/ui/chart';
	import ChartCard from './chart-card.svelte';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import { formatNumber } from '$lib/utils/i18n';
	import { m } from '$lib/paraglide/messages';

	interface Slice {
		name: string;
		count: number;
	}

	interface Props {
		data: Slice[];
		class?: string;
	}

	let { data, class: className }: Props = $props();

	// Categories are nominal: one hue for every bar. A value ramp here would
	// double-encode length as hue and fail the chroma floor (dataviz).
	const config: ChartConfig = {
		count: { label: m.admin_dashboard_legend_posts(), color: 'var(--chart-1)' }
	};

	const series = [
		{
			key: 'count',
			value: 'count',
			color: 'var(--chart-1)',
			label: m.admin_dashboard_legend_posts()
		}
	];

	const hasData = $derived(data.some((d) => d.count > 0));
	const total = $derived(data.reduce((sum, d) => sum + d.count, 0));
</script>

<ChartCard
	title={m.admin_dashboard_chart_categories_title()}
	description={m.admin_dashboard_chart_categories_desc()}
	icon={IconChartBar}
	empty={!hasData}
	class={className}
>
	{#if hasData}
		<p class="mb-2 text-xs text-muted-foreground">
			{m.admin_dashboard_chart_categories_total({ count: formatNumber(total) })}
		</p>
	{/if}

	<ChartContainer
		{config}
		class="aspect-auto w-full"
		style="height: {Math.max(data.length, 1) * 32 + 12}px"
	>
		<BarChart {data} {series} orientation="horizontal" x="count" y="name" />
	</ChartContainer>

	{#snippet table()}
		<table class="w-full text-xs">
			<caption class="sr-only">{m.admin_dashboard_chart_categories_title()}</caption>
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th scope="col" class="py-1 pr-3 font-medium">{m.admin_dashboard_col_category()}</th>
					<th scope="col" class="py-1 text-right font-medium">{m.admin_dashboard_col_count()}</th>
				</tr>
			</thead>
			<tbody>
				{#each data as row (row.name)}
					<tr class="border-b border-border/50 last:border-0">
						<td class="py-1 pr-3">{row.name}</td>
						<td class="py-1 text-right tabular-nums">{formatNumber(row.count)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/snippet}
</ChartCard>

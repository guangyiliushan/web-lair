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

	// B4 - the SQL already caps at TOP_CATEGORIES; slice again here so a caller
	// that passes more cannot undo it.
	const TOP_CATEGORIES = 5;
	const rows = $derived(data.slice(0, TOP_CATEGORIES));

	const hasData = $derived(rows.some((d) => d.count > 0));
	// Totals describe the bars on screen, not the full dataset: past the cap
	// those are different numbers and only one of them is drawn.
	const total = $derived(rows.reduce((sum, d) => sum + d.count, 0));

	/**
	 * B1 - an SVG tick label has no `text-overflow`, so a long category name
	 * spills left out of the card. Cut it here at a width the reserved label
	 * band can always hold; the full name stays in the tooltip and in the
	 * table twin below, so nothing is gated behind the truncation.
	 */
	const MAX_LABEL_CHARS = 6;

	function truncateLabel(name: string): string {
		return name.length > MAX_LABEL_CHARS ? `${name.slice(0, MAX_LABEL_CHARS)}…` : name;
	}
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

	<!-- B2 - reserve the name band on the left and room for the end labels on
	     the right up front, so a label can never be drawn outside the card.
	     B3 - the y axis sheds its rule and tick marks so the names read as
	     direct labels beside each bar, and the count rides at the bar end
	     rather than on an axis. -->
	<ChartContainer
		{config}
		class="aspect-auto w-full"
		style="height: {Math.max(rows.length, 1) * 36 + 20}px"
	>
		<BarChart
			data={rows}
			{series}
			orientation="horizontal"
			x="count"
			y="name"
			padding={{ left: 80, right: 52, top: 6, bottom: 24 }}
			props={{
				xAxis: {
					rule: false,
					tickMarks: false,
					format: (value: number) => formatNumber(value)
				},
				yAxis: {
					rule: false,
					tickMarks: false,
					format: (value: string) => truncateLabel(value)
				}
			}}
			labels={{
				placement: 'outside',
				format: (value: number) => formatNumber(value)
			}}
		/>
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
				{#each rows as row (row.name)}
					<tr class="border-b border-border/50 last:border-0">
						<td class="py-1 pr-3" title={row.name}>{row.name}</td>
						<td class="py-1 text-right tabular-nums">{formatNumber(row.count)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/snippet}
</ChartCard>

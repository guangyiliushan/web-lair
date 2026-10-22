<script lang="ts">
	import { LineChart } from 'layerchart';
	import { ChartContainer, type ChartConfig } from '$lib/components/ui/chart';
	import ChartCard from './chart-card.svelte';
	import IconTrendingUp from '@tabler/icons-svelte-runes/icons/trending-up';
	import { formatNumber } from '$lib/utils/i18n';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	interface Point {
		bucket: string;
		posts: number;
		notes: number;
	}

	interface Props {
		data: Point[];
		class?: string;
	}

	let { data, class: className }: Props = $props();

	// Two series are told apart by categorical slots 1 and 2 — the pair clears
	// every CVD and contrast gate in both themes (dataviz validator).
	const config: ChartConfig = {
		posts: { label: m.admin_dashboard_legend_posts(), color: 'var(--chart-1)' },
		notes: { label: m.admin_dashboard_legend_notes(), color: 'var(--chart-2)' }
	};

	const series = [
		{
			key: 'posts',
			label: m.admin_dashboard_legend_posts(),
			value: 'posts',
			color: 'var(--chart-1)'
		},
		{
			key: 'notes',
			label: m.admin_dashboard_legend_notes(),
			value: 'notes',
			color: 'var(--chart-2)'
		}
	];

	const hasData = $derived(data.some((d) => d.posts > 0 || d.notes > 0));

	// Direct-label the endpoint only; a number on every point is noise.
	const latest = $derived(data.at(-1));

	/**
	 * A2 - the axis is too narrow for `2026-01` twelve times over (that is
	 * ~600px of label in a ~315px plot). Short month names drop each label to
	 * roughly a fifth of that. The year rides along only on January, where it
	 * changes the reading - the window is a rolling 12 months, so it can cross
	 * a year boundary and the first tick alone would not carry it.
	 */
	function monthLabel(bucket: string): string {
		const [year, month] = bucket.split('-').map(Number);
		if (!year || !month) return bucket;
		return new Date(year, month - 1, 1).toLocaleDateString(getLocale(), {
			month: 'short',
			...(month === 1 ? { year: '2-digit' } : {})
		});
	}
</script>

<ChartCard
	title={m.admin_dashboard_chart_publish_title()}
	description={m.admin_dashboard_chart_publish_desc()}
	icon={IconTrendingUp}
	empty={!hasData}
	class={className}
>
	<ul class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
		<li class="flex items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-[2px] bg-chart-1" aria-hidden="true"></span>
			<span>{m.admin_dashboard_legend_posts()}</span>
			{#if latest}<span class="font-medium text-foreground">{formatNumber(latest.posts)}</span>{/if}
		</li>
		<li class="flex items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-[2px] bg-chart-2" aria-hidden="true"></span>
			<span>{m.admin_dashboard_legend_notes()}</span>
			{#if latest}<span class="font-medium text-foreground">{formatNumber(latest.notes)}</span>{/if}
		</li>
	</ul>

	<!-- Labels stay horizontal. Tilting them was tried and read as noise: once
	     the names are short (A2) they do not need the angle, and a 45-degree
	     axis costs a tall band under the plot for no gain. A comfortable
	     tickSpacing sets how many survive; tickOcclusion is the safety net for
	     a locale whose month names are longer than the spacing allows. -->
	<ChartContainer {config} class="aspect-auto h-[180px] w-full">
		<LineChart
			{data}
			{series}
			x="bucket"
			padding={{ top: 8, right: 12, bottom: 22, left: 8 }}
			props={{
				xAxis: {
					rule: false,
					tickMarks: false,
					// A1 - measure the labels as they actually render and drop the
					// ones that would collide, anchoring both ends of the window.
					tickSpacing: 52,
					tickOcclusion: { priority: 'start-end', padding: 4 },
					format: monthLabel
				},
				yAxis: {
					rule: false,
					tickMarks: false,
					format: (value: number) => formatNumber(value)
				}
			}}
		/>
	</ChartContainer>

	{#snippet table()}
		<table class="w-full text-xs">
			<caption class="sr-only">{m.admin_dashboard_chart_publish_title()}</caption>
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th scope="col" class="py-1 pr-3 font-medium">{m.admin_dashboard_col_month()}</th>
					<th scope="col" class="py-1 pr-3 text-right font-medium">
						{m.admin_dashboard_legend_posts()}
					</th>
					<th scope="col" class="py-1 text-right font-medium">{m.admin_dashboard_legend_notes()}</th
					>
				</tr>
			</thead>
			<tbody>
				{#each data as row (row.bucket)}
					<tr class="border-b border-border/50 last:border-0">
						<td class="py-1 pr-3 tabular-nums">{row.bucket}</td>
						<td class="py-1 pr-3 text-right tabular-nums">{formatNumber(row.posts)}</td>
						<td class="py-1 text-right tabular-nums">{formatNumber(row.notes)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/snippet}
</ChartCard>

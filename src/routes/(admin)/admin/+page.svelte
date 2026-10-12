<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { ChartPanel, MaintenanceCard, LoginStat } from '$lib/components/admin';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconFiles from '@tabler/icons-svelte-runes/icons/files';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconTrendingUp from '@tabler/icons-svelte-runes/icons/trending-up';
	import IconActivity from '@tabler/icons-svelte-runes/icons/activity';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconPieChart from '@tabler/icons-svelte-runes/icons/chart-pie';
	import IconTraffic from '@tabler/icons-svelte-runes/icons/chart-dots';
	import IconFlame from '@tabler/icons-svelte-runes/icons/flame';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconBrush from '@tabler/icons-svelte-runes/icons/brush';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';

	let { data }: { data: PageData } = $props();

	// Realtime data
	const realtimeStats = [
		{
			label: m.admin_dashboard_realtime_online(),
			value: 15,
			icon: IconActivity,
			color: 'text-emerald-500',
			bgColor: 'bg-emerald-500/10'
		},
		{
			label: m.admin_dashboard_realtime_today(),
			value: 638,
			icon: IconUsers,
			color: 'text-blue-500',
			bgColor: 'bg-blue-500/10'
		},
		{
			label: m.admin_dashboard_realtime_peak(),
			value: 24,
			icon: IconTrendingUp,
			color: 'text-violet-500',
			bgColor: 'bg-violet-500/10'
		}
	];

	// Quick actions (counts made real: C3; the "Write" deep links on the three micro-content cards auto-open the add dialog via ?add=1)
	const quickActions = $derived([
		{
			title: m.admin_nav_posts(),
			count: data.counts.posts,
			icon: IconArticle,
			writeHref: '/admin/posts/edit',
			manageHref: '/admin/posts'
		},
		{
			title: m.admin_nav_notes(),
			count: data.counts.notes,
			icon: IconNotebook,
			writeHref: '/admin/notes/edit',
			manageHref: '/admin/notes'
		},
		{
			title: m.admin_nav_quotes(),
			count: data.counts.quotes,
			icon: IconQuote,
			writeHref: '/admin/quotes?add=1',
			manageHref: '/admin/quotes'
		},
		{
			title: m.admin_nav_thoughts(),
			count: data.counts.thoughts,
			icon: IconBulb,
			writeHref: '/admin/thoughts?add=1',
			manageHref: '/admin/thoughts'
		},
		{
			title: m.admin_nav_moments(),
			count: data.counts.moments,
			icon: IconWriting,
			writeHref: '/admin/moments?add=1',
			manageHref: '/admin/moments'
		}
	]);

	// Data statistics
	const dataStats = [
		{ label: m.admin_dashboard_stat_pages(), value: 10, icon: IconFiles },
		{ label: m.admin_dashboard_stat_categories(), value: 7, icon: IconChartBar },
		{ label: m.admin_dashboard_stat_comments(), value: '2,418', icon: IconMessage },
		{ label: m.admin_dashboard_stat_comments_unread(), value: 1, icon: IconMessage, badge: true },
		{ label: m.admin_dashboard_stat_friends(), value: 55, icon: IconUsers },
		{ label: m.admin_dashboard_stat_friend_requests(), value: 8, icon: IconUsers },
		{ label: m.admin_dashboard_stat_api_calls(), value: '15,696,939', icon: IconActivity },
		{ label: m.admin_dashboard_stat_ip_today(), value: 345, icon: IconEye },
		{ label: m.admin_dashboard_stat_chars(), value: '1,193,363', icon: IconArticle },
		{ label: m.admin_dashboard_stat_reads(), value: '587,828', icon: IconEye },
		{ label: m.admin_dashboard_stat_post_likes(), value: '2,522', icon: IconTrendingUp },
		{ label: m.admin_dashboard_stat_site_likes(), value: '3,775', icon: IconTrendingUp }
	];

	const lastUpdated = $state(
		new Date().toLocaleTimeString(getLocale(), {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		})
	);
</script>

<div class="flex flex-col gap-6">
	<!-- Welcome heading -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">{m.admin_dashboard_welcome()}</h1>
			<p class="text-sm text-muted-foreground">
				{m.admin_dashboard_welcome_hint({
					name: data.auth?.profile?.displayName ?? data.auth?.user?.name ?? 'Admin'
				})}
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => location.reload()}>
			<IconRefresh data-icon="inline-start" />
			{m.admin_common_refresh()}
		</Button>
	</div>

	<!-- Realtime data -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			{m.admin_dashboard_section_realtime()}
		</h2>
		<div class="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
			{#each realtimeStats as stat (stat.label)}
				<Card.Root>
					<Card.Content class="flex items-center gap-3 p-4 sm:gap-4 sm:p-6">
						<div
							class="flex size-10 items-center justify-center rounded-lg sm:size-12 {stat.bgColor}"
						>
							<stat.icon class="size-5 sm:size-6 {stat.color}" />
						</div>
						<div>
							<p class="text-xl font-bold sm:text-2xl">{stat.value}</p>
							<p class="text-xs text-muted-foreground sm:text-sm">{stat.label}</p>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</section>

	<!-- Quick actions -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			{m.admin_dashboard_section_quick()}
		</h2>
		<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
			{#each quickActions as action (action.title)}
				<Card.Root>
					<Card.Content class="p-3 sm:p-6">
						<div class="flex items-center gap-2 sm:gap-3">
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted sm:size-10"
							>
								<action.icon class="size-4 text-muted-foreground sm:size-5" />
							</div>
							<div class="min-w-0">
								<p class="truncate text-xs font-medium text-muted-foreground sm:text-sm">
									{action.title}
								</p>
								<p class="text-xl font-bold tabular-nums sm:text-2xl">{action.count}</p>
							</div>
						</div>
						<div class="mt-3 flex gap-1.5 sm:mt-4 sm:gap-2">
							<Button
								size="sm"
								variant="default"
								href={action.writeHref}
								class="flex-1 sm:flex-none"
							>
								{m.admin_dashboard_quick_write()}
							</Button>
							<Button
								size="sm"
								variant="outline"
								href={action.manageHref}
								class="flex-1 sm:flex-none"
							>
								{m.admin_dashboard_quick_manage()}
							</Button>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</section>

	<!-- Data statistics -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<div class="flex items-center justify-between">
			<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
				{m.admin_dashboard_section_stats()}
			</h2>
			<span class="text-[10px] text-muted-foreground sm:text-xs"
				>{m.admin_dashboard_updated_at({ time: lastUpdated })}</span
			>
		</div>
		<Card.Root data-size="sm">
			<Card.Content class="p-4 sm:p-6">
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
					{#each dataStats as stat (stat.label)}
						<div class="flex items-center gap-2 sm:gap-3">
							<div
								class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/50 sm:size-9"
							>
								<stat.icon class="size-3.5 text-muted-foreground sm:size-4" />
							</div>
							<div class="min-w-0">
								<div class="flex items-center gap-1 sm:gap-1.5">
									<p class="truncate text-base font-semibold tabular-nums sm:text-lg">
										{stat.value}
									</p>
									{#if stat.badge}
										<span class="flex size-1.5 shrink-0 rounded-full bg-red-500 sm:size-2"></span>
									{/if}
								</div>
								<p class="truncate text-[10px] text-muted-foreground sm:text-xs">{stat.label}</p>
							</div>
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<Separator />

	<!-- ## Data insights -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			{m.admin_dashboard_section_insights()}
		</h2>

		<!-- Publishing trend + category split -->
		<div class="mt-6 grid gap-4 xl:grid-cols-2">
			<ChartPanel
				title={m.admin_dashboard_chart_publish_title()}
				description={m.admin_dashboard_chart_publish_desc()}
				icon={IconTrendingUp}
				empty={true}
			/>
			<ChartPanel
				title={m.admin_dashboard_chart_categories_title()}
				description={m.admin_dashboard_chart_categories_desc()}
				icon={IconPieChart}
				empty={true}
			/>
		</div>

		<!-- Comment activity + traffic sources -->
		<div class="grid gap-4 xl:grid-cols-2">
			<ChartPanel
				title={m.admin_dashboard_chart_comments_title()}
				description={m.admin_dashboard_chart_comments_desc()}
				icon={IconChartBar}
				empty={true}
			/>

			<!-- Traffic sources -->
			<Card.Root>
				<Card.Header>
					<div class="flex items-center gap-2">
						<IconTraffic class="size-4 text-muted-foreground" />
						<Card.Title class="text-sm font-medium">{m.admin_dashboard_traffic_title()}</Card.Title>
					</div>
					<Card.Description>{m.admin_dashboard_traffic_desc()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="grid gap-px bg-border sm:grid-cols-2">
						<div class="bg-surface-card p-4">
							<h3 class="mb-3 text-xs font-medium text-muted-foreground uppercase">
								{m.admin_dashboard_traffic_browser()}
							</h3>
							<div class="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
								{m.admin_common_empty()}
							</div>
						</div>
						<div class="bg-surface-card p-4">
							<h3 class="mb-3 text-xs font-medium text-muted-foreground uppercase">
								{m.admin_dashboard_traffic_os()}
							</h3>
							<div class="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
								{m.admin_common_empty()}
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<!-- Popular posts + tag cloud -->
		<div class="grid gap-4 xl:grid-cols-2">
			<ChartPanel
				title={m.admin_dashboard_chart_hot_title()}
				description={m.admin_dashboard_chart_hot_desc()}
				icon={IconFlame}
				empty={true}
			/>
			<ChartPanel
				title={m.admin_dashboard_chart_tags_title()}
				description={m.admin_dashboard_chart_tags_desc()}
				icon={IconTag}
				empty={true}
			/>
		</div>
	</section>

	<Separator />

	<!-- ## System operations -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			{m.admin_dashboard_section_system()}
		</h2>

		<Card.Root class="mt-6">
			<Card.Header>
				<div class="flex items-center gap-2">
					<IconBrush class="size-4 text-muted-foreground" />
					<Card.Title class="text-sm font-medium">{m.admin_dashboard_cache_title()}</Card.Title>
				</div>
				<Card.Description>{m.admin_dashboard_cache_desc()}</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid gap-px bg-border sm:grid-cols-2">
					<MaintenanceCard icon={IconBrush} label={m.admin_dashboard_cache_api()} value="HTTP">
						<Button variant="outline" size="sm">{m.admin_common_clear()}</Button>
					</MaintenanceCard>
					<MaintenanceCard icon={IconBrush} label={m.admin_dashboard_cache_data()} value="Redis">
						<Button variant="outline" size="sm">{m.admin_common_clear()}</Button>
					</MaintenanceCard>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<IconSearch class="size-4 text-muted-foreground" />
					<Card.Title class="text-sm font-medium">{m.admin_dashboard_search_title()}</Card.Title>
				</div>
				<Card.Description>{m.admin_dashboard_search_desc()}</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
					<MaintenanceCard
						icon={IconSearch}
						label={m.admin_dashboard_search_label()}
						value="BM25"
						description={m.admin_dashboard_search_desc()}
					>
						<Button variant="outline" size="sm">{m.admin_dashboard_search_incremental()}</Button>
						<Button
							variant="outline"
							size="sm"
							class="border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-950 dark:text-amber-300 dark:hover:bg-amber-950/30"
							>{m.admin_dashboard_search_force()}</Button
						>
					</MaintenanceCard>
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<Separator />

	<!-- ## Account login info -->
	<LoginStat lastLoginTime="2026/07/06 19:09" lastLoginIp={null} />
</div>

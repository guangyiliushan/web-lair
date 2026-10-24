<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { resolve } from '$app/paths';
	import { formatNumber } from '$lib/utils/i18n';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { LoginStat } from '$lib/components/admin';
	import { PublishTrend, CategoryBars, CommentActivity } from '$lib/components/admin/charts';
	import { openPresenceStream } from '$lib/components/presence';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconActivity from '@tabler/icons-svelte-runes/icons/activity';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconTrendingUp from '@tabler/icons-svelte-runes/icons/trending-up';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';
	import IconArrowRight from '@tabler/icons-svelte-runes/icons/arrow-right';

	let { data }: { data: PageData } = $props();

	// Realtime data (E1): SSR initial values from the presence service, kept
	// live over the admin SSE stream; null = disabled/unavailable -> "—".
	// Initial captures only - `untrack` documents the intent and silences
	// state_referenced_locally (the photos-viewer-overlay precedent).
	const realtime = $state({
		site: untrack(() => data.presence.site) as number | null,
		day: untrack(() => data.presence.day) as number | null,
		peak: untrack(() => data.presence.peak) as number | null
	});
	let realtimeUpdatedAt = $state<string | null>(null);

	$effect(() => {
		if (!data.presence.enabled) return;
		return openPresenceStream({
			url: '/api/presence/stream',
			onSnapshot: (payload) => {
				const snapshot = payload as {
					site: number | null;
					day: number | null;
					peak: number | null;
				};
				realtime.site = snapshot.site;
				realtime.day = snapshot.day;
				realtime.peak = snapshot.peak;
				realtimeUpdatedAt = timeLabel();
			}
		});
	});

	const realtimeStats = $derived([
		{
			metric: 'site',
			label: m.admin_dashboard_realtime_online(),
			value: realtime.site,
			icon: IconActivity
		},
		{
			metric: 'day',
			label: m.admin_dashboard_realtime_today(),
			value: realtime.day,
			icon: IconUsers
		},
		{
			metric: 'peak',
			label: m.admin_dashboard_realtime_peak(),
			value: realtime.peak,
			icon: IconTrendingUp
		}
	]);

	// Quick actions (counts made real: C3; the "Write" deep links on the three
	// micro-content rows auto-open the add dialog via ?add=1)
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

	// Data statistics: every value comes from the load's real aggregates.
	// API calls, IP visits and site likes were removed - the app has no source
	// for them, and a fabricated value must never look live here. Reads and
	// likes are gone for the same reason: no write path increments those
	// columns yet, so they always rendered as a confident 0.
	const dataStats = $derived([
		{ label: m.admin_dashboard_stat_pages(), value: data.stats.pages },
		{ label: m.admin_dashboard_stat_categories(), value: data.stats.categories },
		{ label: m.admin_dashboard_stat_comments(), value: data.stats.comments },
		{
			label: m.admin_dashboard_stat_comments_unread(),
			value: data.stats.commentsUnread,
			attention: data.stats.commentsUnread > 0
		},
		{ label: m.admin_dashboard_stat_friends(), value: data.stats.friends },
		{
			label: m.admin_dashboard_stat_friend_requests(),
			value: data.stats.friendRequests,
			attention: data.stats.friendRequests > 0
		},
		{ label: m.admin_dashboard_stat_chars(), value: data.stats.characters }
	]);

	const displayName = $derived(data.auth?.profile?.displayName ?? data.auth?.user?.name ?? 'Admin');

	function timeLabel(): string {
		return new Date().toLocaleTimeString(getLocale(), {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}
</script>

<div class="flex flex-col gap-4 p-4 sm:p-6 lg:p-8">
	<!-- Welcome + refresh: one compact bar, not a hero block -->
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-xl font-semibold tracking-tight">{m.admin_dashboard_welcome()}</h1>
			<p class="truncate text-xs text-muted-foreground">
				{m.admin_dashboard_welcome_hint({ name: displayName })}
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => location.reload()}>
			<IconRefresh data-icon="inline-start" />
			{m.admin_common_refresh()}
		</Button>
	</div>

	<!-- Realtime: three numbers in one strip rather than three fat cards -->
	<section class="flex flex-col gap-2">
		<div class="flex items-center justify-between">
			<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				{m.admin_dashboard_section_realtime()}
			</h2>
			{#if realtimeUpdatedAt}
				<span class="text-[10px] text-muted-foreground" data-slot="realtime-updated">
					{m.admin_dashboard_updated_at({ time: realtimeUpdatedAt })}
				</span>
			{/if}
		</div>
		<Card.Root class="py-0">
			<div class="grid grid-cols-3 divide-x divide-border">
				{#each realtimeStats as stat (stat.metric)}
					<div class="flex items-center gap-2.5 px-4 py-3">
						<stat.icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div class="min-w-0">
							<p class="text-lg leading-tight font-semibold" data-metric={stat.metric}>
								{stat.value ?? '—'}
							</p>
							<p class="truncate text-[11px] text-muted-foreground">{stat.label}</p>
						</div>
					</div>
				{/each}
			</div>
		</Card.Root>
	</section>

	<!-- Statistics: one strip, value over label, no decorative icons -->
	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{m.admin_dashboard_section_stats()}
		</h2>
		<Card.Root class="py-0">
			<div
				class="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3 lg:grid-cols-7 lg:divide-y-0"
			>
				{#each dataStats as stat (stat.label)}
					<div class="px-4 py-3">
						<p class="text-lg leading-tight font-semibold">{formatNumber(stat.value)}</p>
						<p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							{stat.label}
							{#if stat.attention}
								<span class="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true"
								></span>
							{/if}
						</p>
					</div>
				{/each}
			</div>
		</Card.Root>
	</section>

	<!-- Charts: three panels with real aggregates behind them -->
	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{m.admin_dashboard_section_insights()}
		</h2>
		<div class="grid gap-4 lg:grid-cols-3">
			<PublishTrend data={data.charts.publish} />
			<CategoryBars data={data.charts.categories} />
			<CommentActivity data={data.charts.comments} />
		</div>
	</section>

	<!-- Quick actions. Below md this is the same single-line list the phone
	     layout wants; above it the rows flow into a grid so a wide screen stops
	     paying five row-heights for five items. The button pair is free to wrap
	     under the title once a cell gets narrow, which is what lets five-across
	     pack in without crushing them. That step is gated at 1440px rather than
	     Tailwind's xl (1280): at 1280 the cells land around 192px and the
	     button pair still feels pinched. Column rules use the border trick (the
	     ul pulls the last rule under the card edge) so a short final row leaves
	     no stray marks. -->
	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{m.admin_dashboard_section_quick()}
		</h2>
		<Card.Root class="py-0">
			<ul
				class="-mr-px -mb-px grid grid-cols-1 min-[1440px]:grid-cols-5 md:grid-cols-2 lg:grid-cols-3"
			>
				{#each quickActions as action (action.title)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 md:border-r"
					>
						<action.icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate text-sm">{action.title}</span>
						<span class="text-sm font-semibold">{formatNumber(action.count)}</span>
						<div class="flex shrink-0 items-center gap-1">
							<Button size="sm" variant="ghost" href={action.writeHref}>
								{m.admin_dashboard_quick_write()}
							</Button>
							<Button size="sm" variant="outline" href={action.manageHref}>
								{m.admin_dashboard_quick_manage()}
							</Button>
						</div>
					</li>
				{/each}
			</ul>
		</Card.Root>
	</section>

	<!-- Maintenance entry. The cache/search panel this replaces carried four
	     buttons with no handlers at all; the job registry has no cache.clear or
	     search.rebuild definition, so those actions do not exist yet. Point at
	     the one surface that does rather than ship dead controls. -->
	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{m.admin_dashboard_section_system()}
		</h2>
		<Card.Root class="py-0">
			<a
				class="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				href={resolve('/admin/maintenance')}
			>
				<IconTool class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span class="flex-1">
					<span class="block font-medium">{m.admin_nav_maintenance()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_dashboard_maintenance_hint()}
					</span>
				</span>
				<IconArrowRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			</a>
		</Card.Root>
	</section>

	<LoginStat
		lastLoginAt={data.lastAdminLogin?.at ?? null}
		lastLoginIp={data.lastAdminLogin?.ip ?? null}
		firstLogin={data.lastAdminLogin?.first ?? false}
		timeZone={data.siteTimezone}
	/>
</div>

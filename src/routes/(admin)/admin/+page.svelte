<script lang="ts">
	import type { PageData } from './$types';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { ChartPanel, MaintenanceCard, LoginStat } from '$lib/components/admin';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
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

	// 实时数据
	const realtimeStats = [
		{
			label: '当前在线访客',
			value: 15,
			icon: IconActivity,
			color: 'text-emerald-500',
			bgColor: 'bg-emerald-500/10'
		},
		{
			label: '今日访客',
			value: 638,
			icon: IconUsers,
			color: 'text-blue-500',
			bgColor: 'bg-blue-500/10'
		},
		{
			label: '今日最高在线',
			value: 24,
			icon: IconTrendingUp,
			color: 'text-violet-500',
			bgColor: 'bg-violet-500/10'
		}
	];

	// 快速操作
	const quickActions = [
		{
			title: '博文',
			count: 167,
			icon: IconArticle,
			writeHref: '/admin/posts/edit',
			manageHref: '/admin/posts'
		},
		{
			title: '日记',
			count: 188,
			icon: IconPencil,
			writeHref: '/admin/notes?type=diary',
			manageHref: '/admin/notes?type=diary'
		},
		{
			title: '速记',
			count: 88,
			icon: IconNotebook,
			writeHref: '/admin/notes?type=quick',
			manageHref: '/admin/notes?type=quick'
		},
		{
			title: '说说',
			count: 38,
			icon: IconQuote,
			writeHref: '/admin/says',
			manageHref: '/admin/says'
		}
	];

	// 数据统计
	const dataStats = [
		{ label: '页面', value: 10, icon: IconFiles },
		{ label: '分类', value: 7, icon: IconChartBar },
		{ label: '全部评论', value: '2,418', icon: IconMessage },
		{ label: '未读评论', value: 1, icon: IconMessage, badge: true },
		{ label: '友链', value: 55, icon: IconUsers },
		{ label: '友链申请', value: 8, icon: IconUsers },
		{ label: 'API 调用', value: '15,696,939', icon: IconActivity },
		{ label: '今日 IP 访问', value: 345, icon: IconEye },
		{ label: '全站字符数', value: '1,193,363', icon: IconArticle },
		{ label: '总阅读量', value: '587,828', icon: IconEye },
		{ label: '文章点赞', value: '2,522', icon: IconTrendingUp },
		{ label: '站点点赞', value: '3,775', icon: IconTrendingUp }
	];

	const lastUpdated = $state(
		new Date().toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		})
	);
</script>

<div class="flex flex-col gap-6">
	<!-- 欢迎标题 -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">欢迎回来</h1>
			<p class="text-sm text-muted-foreground">
				{data.auth?.profile?.displayName ?? data.auth?.user?.name ?? 'Admin'}，这是你的个人仪表盘
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => location.reload()}>
			<IconRefresh data-icon="inline-start" />
			刷新
		</Button>
	</div>

	<!-- 实时数据 -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			实时数据
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

	<!-- 快速操作 -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			快速操作
		</h2>
		<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
								撰写
							</Button>
							<Button
								size="sm"
								variant="outline"
								href={action.manageHref}
								class="flex-1 sm:flex-none"
							>
								管理
							</Button>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</section>

	<!-- 数据统计 -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<div class="flex items-center justify-between">
			<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
				数据统计
			</h2>
			<span class="text-[10px] text-muted-foreground sm:text-xs">更新于 {lastUpdated}</span>
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

	<!-- ## 数据洞察 -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			数据洞察
		</h2>

		<!-- 发布趋势 + 分类分布 -->
		<div class="mt-6 grid gap-4 xl:grid-cols-2">
			<ChartPanel
				title="发布趋势"
				description="内容发布时间线统计"
				icon={IconTrendingUp}
				empty={true}
			/>
			<ChartPanel
				title="分类分布"
				description="各内容分类占比统计"
				icon={IconPieChart}
				empty={true}
			/>
		</div>

		<!-- 评论活动 + 流量来源 -->
		<div class="grid gap-4 xl:grid-cols-2">
			<ChartPanel
				title="评论活动"
				description="日期维度评论量统计"
				icon={IconChartBar}
				empty={true}
			/>

			<!-- 流量来源 -->
			<Card.Root>
				<Card.Header>
					<div class="flex items-center gap-2">
						<IconTraffic class="size-4 text-muted-foreground" />
						<Card.Title class="text-sm font-medium">流量来源</Card.Title>
					</div>
					<Card.Description>浏览器与操作系统访问分布</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="grid gap-px bg-border sm:grid-cols-2">
						<div class="bg-surface-card p-4">
							<h3 class="mb-3 text-xs font-medium text-muted-foreground uppercase">Browser</h3>
							<div class="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
								暂无数据
							</div>
						</div>
						<div class="bg-surface-card p-4">
							<h3 class="mb-3 text-xs font-medium text-muted-foreground uppercase">OS</h3>
							<div class="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
								暂无数据
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<!-- 热门文章 + 标签云 -->
		<div class="grid gap-4 xl:grid-cols-2">
			<ChartPanel title="热门文章" description="阅读量 TOP 排行榜" icon={IconFlame} empty={true} />
			<ChartPanel title="标签云" description="标签热度权重云图" icon={IconTag} empty={true} />
		</div>
	</section>

	<Separator />

	<!-- ## 系统操作 -->
	<section class="flex flex-col gap-2 sm:gap-3">
		<h2 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:text-sm">
			系统操作
		</h2>

		<Card.Root class="mt-6">
			<Card.Header>
				<div class="flex items-center gap-2">
					<IconBrush class="size-4 text-muted-foreground" />
					<Card.Title class="text-sm font-medium">缓存管理</Card.Title>
				</div>
				<Card.Description>API 数据缓存与 HTTP 数据缓存（存储介质：Redis）</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid gap-px bg-border sm:grid-cols-2">
					<MaintenanceCard icon={IconBrush} label="API 缓存" value="HTTP">
						<Button variant="outline" size="sm">清除</Button>
					</MaintenanceCard>
					<MaintenanceCard icon={IconBrush} label="数据缓存" value="Redis">
						<Button variant="outline" size="sm">清除</Button>
					</MaintenanceCard>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<IconSearch class="size-4 text-muted-foreground" />
					<Card.Title class="text-sm font-medium">搜索索引管理</Card.Title>
				</div>
				<Card.Description>按需重建全文索引；强制模式会清空后全量重建。</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
					<MaintenanceCard
						icon={IconSearch}
						label="搜索索引"
						value="BM25"
						description="按需重建全文索引；强制模式会清空后全量重建。"
					>
						<Button variant="outline" size="sm">增量重建</Button>
						<Button
							variant="outline"
							size="sm"
							class="border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-950 dark:text-amber-300 dark:hover:bg-amber-950/30"
							>强制全量重建</Button
						>
					</MaintenanceCard>
				</div>
			</Card.Content>
		</Card.Root>
	</section>

	<Separator />

	<!-- ## 账号登录信息 -->
	<LoginStat lastLoginTime="2026/07/06 19:09" lastLoginIp={null} />
</div>

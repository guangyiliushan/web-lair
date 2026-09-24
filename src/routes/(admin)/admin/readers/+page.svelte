<script lang="ts">
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import { Button } from '$lib/components/ui/button';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconCrown from '@tabler/icons-svelte-runes/icons/crown';
	import IconShieldCheck from '@tabler/icons-svelte-runes/icons/shield-check';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconBan from '@tabler/icons-svelte-runes/icons/ban';
	import IconUserStar from '@tabler/icons-svelte-runes/icons/user-star';
	import IconUserMinus from '@tabler/icons-svelte-runes/icons/user-minus';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';

	interface Reader {
		id: string;
		name: string;
		username: string;
		email: string;
		avatar: string;
		role: 'owner' | 'reader';
		verified: boolean;
		joinedAt: string;
		lastLogin: string;
		updatedAt: string;
	}

	const readers: Reader[] = [
		{
			id: '71f8fcef-f1d8-41dd-ab6a-7827faa39713',
			name: 'test',
			username: 'test',
			email: 'test@test.com',
			avatar: 'https://cravatar.cn/avatar/b642b4217b34b1e8d3bd915fc65c4452?d=retro',
			role: 'owner',
			verified: true,
			joinedAt: '11 天前',
			lastLogin: '5 小时前',
			updatedAt: '从未登录'
		}
	];

	const roleFilters = ['all', 'owner', 'reader'] as const;
	const roleLabels: Record<string, string> = { all: '全部', owner: '站长', reader: '读者' };

	let searchQuery = $state('');
	let selectedRole = $state('all');
	let selectedReaderId = $state<string | null>(null);

	const roleCounts = $derived({
		all: readers.length,
		owner: readers.filter((r) => r.role === 'owner').length,
		reader: readers.filter((r) => r.role === 'reader').length
	});

	const filteredReaders = $derived(
		readers.filter((r) => {
			const matchRole = selectedRole === 'all' || r.role === selectedRole;
			const matchSearch =
				r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
				r.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
				r.email.toLowerCase().includes(searchQuery.toLowerCase());
			return matchRole && matchSearch;
		})
	);

	const selectedReader = $derived(readers.find((r) => r.id === selectedReaderId) ?? null);
</script>

<svelte:head>
	<title>读者管理 - Lair Admin</title>
</svelte:head>

<MasterDetail.Root class="h-[calc(100vh-10rem)]">
	<!-- ===== 左侧：读者列表 ===== -->
	<MasterDetail.Pane side="master" class="w-80 shrink-0">
		<MasterDetail.Header icon={IconUsers} title="读者" count={readers.length} />

		<!-- 角色筛选标签（带计数） -->
		<div class="flex flex-wrap gap-2 border-b px-4 py-3">
			{#each roleFilters as role (role)}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition-colors {selectedRole ===
					role
						? 'border-foreground bg-foreground text-background'
						: 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}"
					onclick={() => (selectedRole = role)}
				>
					<span>{roleLabels[role]}</span>
					<span
						class="tabular-nums {selectedRole === role
							? 'text-background/70'
							: 'text-muted-foreground'}">{roleCounts[role]}</span
					>
				</button>
			{/each}
		</div>

		<!-- 搜索栏 -->
		<div class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
			<div class="relative min-w-0 flex-1">
				<IconSearch
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					type="text"
					placeholder="搜索读者"
					class="bg-surface-card h-8 w-full rounded-sm border border-border pr-3 pl-9 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/15"
					bind:value={searchQuery}
				/>
			</div>
			<Button variant="outline" size="icon" class="size-8" aria-label="刷新">
				<IconRefresh class="size-4" />
			</Button>
		</div>

		<MasterDetail.List>
			{#if filteredReaders.length === 0}
				<div class="flex flex-col items-center gap-1 py-12">
					<p class="text-sm text-muted-foreground">暂无读者</p>
				</div>
			{:else}
				{#each filteredReaders as reader (reader.id)}
					<MasterDetail.Item
						selected={selectedReaderId === reader.id}
						onclick={() => (selectedReaderId = reader.id)}
					>
						<img
							alt=""
							class="size-10 shrink-0 rounded-full object-cover ring-1 ring-border"
							src={reader.avatar}
						/>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="truncate text-sm font-medium">{reader.name}</span>
								{#if reader.role === 'owner'}
									<span
										class="flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500"
										title="站长"
									>
										<IconCrown class="size-2.5" />
									</span>
								{/if}
							</div>
							<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
								<span class="shrink-0 truncate">@{reader.username}</span>
								<span aria-hidden="true">·</span>
								<span class="min-w-0 truncate">{reader.email}</span>
								<span aria-hidden="true">·</span>
								<span class="shrink-0">{reader.lastLogin}</span>
							</div>
						</div>
					</MasterDetail.Item>
				{/each}
			{/if}
		</MasterDetail.List>
	</MasterDetail.Pane>

	<!-- ===== 右侧：读者详情 ===== -->
	<MasterDetail.Pane side="detail">
		{#if selectedReader}
			{@const reader = selectedReader}
			<MasterDetail.Header title="读者详情" />

			<div class="flex min-h-0 flex-1 flex-col">
				<!-- 用户信息概览 -->
				<div class="flex items-center gap-3 border-b px-4 py-3">
					<img
						alt=""
						class="size-12 shrink-0 rounded-full object-cover ring-1 ring-border"
						src={reader.avatar}
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<h3 class="truncate text-base leading-tight font-semibold">{reader.name}</h3>
							{#if reader.role === 'owner'}
								<span
									class="flex size-5 items-center justify-center rounded-full bg-amber-500/10 text-amber-500"
									title="站长"
								>
									<IconCrown class="size-3" />
								</span>
							{/if}
						</div>
						<div
							class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
						>
							<span class="truncate">@{reader.username}</span>
							<span class="truncate">{reader.email}</span>
							{#if reader.verified}
								<span class="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
									<IconShieldCheck class="size-3" />
									已验证
								</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-auto p-4">
					<div class="flex flex-col gap-6">
						<!-- 身份信息 -->
						<section class="flex flex-col gap-3">
							<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								身份
							</h3>
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<div class="rounded-md border p-3">
									<div class="text-xs text-muted-foreground">ID</div>
									<div class="mt-1 flex items-center gap-2">
										<code class="min-w-0 truncate text-sm">{reader.id}</code>
										<button
											class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
											title="复制 ID"
											type="button"
										>
											<IconCopy class="size-4" />
										</button>
									</div>
								</div>
								<div class="rounded-md border p-3">
									<div class="text-xs text-muted-foreground">用户名</div>
									<div class="mt-1 truncate text-sm">{reader.username}</div>
								</div>
								<div class="rounded-md border p-3 sm:col-span-2">
									<div class="text-xs text-muted-foreground">显示名称</div>
									<div class="mt-1 truncate text-sm">{reader.name}</div>
								</div>
							</div>
							<div class="divide-y rounded-md border px-3">
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">邮箱</span>
									<span class="min-w-0 truncate text-right text-sm">{reader.email}</span>
								</div>
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">账号</span>
									<span class="min-w-0 truncate text-right text-sm">@{reader.username}</span>
								</div>
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">角色</span>
									<span class="min-w-0 truncate text-right text-sm">{roleLabels[reader.role]}</span>
								</div>
							</div>
						</section>

						<!-- 活动信息 -->
						<section class="flex flex-col gap-3">
							<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								活动
							</h3>
							<div class="divide-y rounded-md border px-3">
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">加入时间</span>
									<time class="min-w-0 truncate text-right text-sm">{reader.joinedAt}</time>
								</div>
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">最近登录</span>
									<time class="min-w-0 truncate text-right text-sm">{reader.lastLogin}</time>
								</div>
								<div class="flex items-baseline justify-between gap-4 py-2">
									<span class="shrink-0 text-xs text-muted-foreground">更新时间</span>
									<span class="text-right text-sm">{reader.updatedAt}</span>
								</div>
							</div>
						</section>
					</div>
				</div>

				<!-- 底部操作栏 -->
				<div class="flex flex-wrap items-center gap-2 border-t px-4 py-3">
					<Button variant="outline" size="sm" disabled={reader.role === 'owner'}>
						<IconUserStar class="size-4" />
						转让站长
					</Button>
					<Button variant="outline" size="sm" disabled={reader.role !== 'owner'}>
						<IconUserMinus class="size-4" />
						撤销站长
					</Button>
					<div class="flex-1"></div>
					<Button
						variant="outline"
						size="sm"
						class="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
						disabled={reader.role === 'owner'}
						title={reader.role === 'owner' ? '无法封禁站长' : ''}
					>
						<IconBan class="size-4" />
						封禁
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex flex-1 items-center justify-center">
				<div class="flex flex-col items-center gap-2 text-center">
					<IconUsers class="size-10 text-muted-foreground/40" />
					<h3 class="text-lg font-semibold tracking-tight">选择一位读者</h3>
					<p class="text-sm text-muted-foreground">从左侧列表中选择读者以查看详情</p>
				</div>
			</div>
		{/if}
	</MasterDetail.Pane>
</MasterDetail.Root>

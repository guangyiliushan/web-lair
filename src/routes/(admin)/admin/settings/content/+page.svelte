<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);

	const commentToggles: { key: string; label: string }[] = [
		{ key: 'antiSpam', label: '反垃圾' },
		{ key: 'aiReview', label: 'AI 审核' },
		{ key: 'disableComments', label: '关闭评论' },
		{ key: 'allowAnonymousComments', label: '允许匿名评论' },
		{ key: 'rejectNonChinese', label: '仅允许中文评论' },
		{ key: 'onlyApproved', label: '仅允许已批准评论显示' },
		{ key: 'showCommentLocation', label: '显示评论归属地' }
	];

	const friendLinkToggles: { key: string; label: string; description: string }[] = [
		{ key: 'allowFriendApps', label: '允许友链申请', description: '开启后外部用户可提交友链申请。' },
		{ key: 'allowSubPathFriends', label: '允许子路径友链', description: '允许友链指向子路径。' },
		{ key: 'internalizeAvatars', label: '本地化头像', description: '将友链头像缓存到本地存储。' }
	];
</script>

<svelte:head>
	<title>Content 设定 - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<!-- Comment settings -->
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">评论</h2>
				<p class="mt-1 text-xs text-muted-foreground">评论审核、反垃圾与内容过滤。</p>
			</div>
		</header>
		<div class="space-y-5">
			{#each commentToggles as item (item.key)}
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">{item.label}</span>
					<button
						type="button"
						role="switch"
						aria-checked={Boolean(s.content[item.key as keyof typeof s.content])}
						aria-label={item.label}
						class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.content[item.key as keyof typeof s.content]}
						class:bg-surface-inset={!s.content[item.key as keyof typeof s.content]}
					>
						<span
							class="shadow-xs block size-4 rounded-full bg-white transition-transform"
							class:translate-x-4={s.content[item.key as keyof typeof s.content]}
						></span>
					</button>
				</div>
			{/each}
			{#if s.content.aiReview}
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">AI 审核模式</span>
					<Select.Root type="single" value={s.content.aiReviewMode}>
						<Select.Trigger class="w-32">
							{s.content.aiReviewMode === 'binary' ? '二分类' : '评分'}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="binary">二分类</Select.Item>
							<Select.Item value="score">评分</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">AI 审核阈值</span>
					<Input class="w-24" type="number" value={s.content.aiReviewThreshold} />
				</div>
			{/if}
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">屏蔽词</span>
				<div class="min-w-0 max-w-[60%] flex-1">
					<div class="flex flex-wrap gap-2">
						{#each s.content.blockedKeywords as kw (kw)}
							<Badge variant="secondary" class="gap-1">
								{kw}
								<button type="button" class="relative inline-flex size-3 items-center after:absolute after:-inset-2" aria-label="移除 {kw}"><IconX class="size-3" /></button>
							</Badge>
						{/each}
					</div>
					<Input class="mt-2" type="text" placeholder="输入后按 Enter" />
				</div>
			</div>
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">屏蔽 IP</span>
				<div class="min-w-0 max-w-[60%] flex-1">
					<div class="flex flex-wrap gap-2">
						{#each s.content.blockedIps as ip (ip)}
							<Badge variant="secondary" class="gap-1">
								{ip}
								<button type="button" class="relative inline-flex size-3 items-center after:absolute after:-inset-2" aria-label="移除 {ip}"><IconX class="size-3" /></button>
							</Badge>
						{/each}
					</div>
					<Input class="mt-2" type="text" placeholder="输入后按 Enter" />
				</div>
			</div>
		</div>
	</section>

	<!-- Friend link settings -->
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">友链</h2>
				<p class="mt-1 text-xs text-muted-foreground">友链申请、子路径与头像本地化。</p>
			</div>
		</header>
		<div class="space-y-5">
			{#each friendLinkToggles as item (item.key)}
				<div class="flex items-center justify-between gap-4">
					<div class="min-w-0">
						<div class="text-sm">{item.label}</div>
						<p class="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={Boolean(s.content[item.key as keyof typeof s.content])}
						aria-label={item.label}
						class="outline-hidden relative inline-flex h-5 min-w-9 shrink-0 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.content[item.key as keyof typeof s.content]}
						class:bg-surface-inset={!s.content[item.key as keyof typeof s.content]}
					>
						<span
							class="shadow-xs block size-4 rounded-full bg-white transition-transform"
							class:translate-x-4={s.content[item.key as keyof typeof s.content]}
						></span>
					</button>
				</div>
			{/each}
		</div>
	</section>

	<div class="flex justify-end">
		<Button type="button" size="sm">
			<IconDeviceFloppy data-icon="inline-start" />
			保存
		</Button>
	</div>
</div>

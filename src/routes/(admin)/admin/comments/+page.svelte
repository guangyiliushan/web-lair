<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconInbox from '@tabler/icons-svelte-runes/icons/inbox';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconClock from '@tabler/icons-svelte-runes/icons/clock';
	import IconGlobe from '@tabler/icons-svelte-runes/icons/globe';

	let { data, form }: PageProps = $props();

	const tabs = [
		{ id: 'pending', label: '待审' },
		{ id: 'approved', label: '已通过' },
		{ id: 'rejected', label: '已拒绝' }
	] as const;

	function formatDate(value: Date | string | null): string {
		if (!value) return '—';
		const date = value instanceof Date ? value : new Date(value);
		return date.toLocaleString('zh-CN', { hour12: false });
	}

	function avatarText(name: string | null): string {
		return (name ?? '?').slice(0, 1).toUpperCase();
	}
</script>

<svelte:head>
	<title>评论管理 - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background">
	<!-- Review state tabs -->
	<div class="bg-surface-card flex h-12 shrink-0 items-stretch gap-2 border-b px-3">
		{#each tabs as tab (tab.id)}
			{@const isActive = data.state === tab.id}
			<a
				href="?state={tab.id}"
				class="relative inline-flex h-full shrink-0 items-center gap-1.5 px-3 text-sm transition-colors"
				class:text-foreground={isActive}
				class:text-muted-foreground={!isActive}
				class:hover:text-foreground={!isActive}
				role="tab"
				aria-selected={isActive}
			>
				{#if isActive}
					<span aria-hidden="true" class="bg-surface-inset absolute inset-x-0 inset-y-2 rounded-sm"
					></span>
				{/if}
				<span class="relative z-10">{tab.label}</span>
				{#if data.counts[tab.id] > 0}
					<span class="relative z-10 ml-0.5 text-xs opacity-60">{data.counts[tab.id]}</span>
				{/if}
			</a>
		{/each}
	</div>

	{#if form && 'message' in form}
		<p class="px-4 py-2 text-sm text-destructive">{form.message}</p>
	{/if}
	{#if form && 'reviewed' in form}
		<p class="px-4 py-2 text-sm text-muted-foreground">
			{form.decision === 'approve' ? '已通过' : '已拒绝'}
			{form.reviewed} 条
		</p>
	{/if}

	{#if data.entries.length === 0}
		<div class="flex flex-1 items-center justify-center p-6">
			<div
				class="bg-surface-inset flex max-w-sm flex-col items-center justify-center gap-3 rounded-xl p-10 text-center"
			>
				<span class="bg-surface-card flex size-11 items-center justify-center rounded-lg shadow-xs">
					<IconInbox class="size-5 text-muted-foreground" />
				</span>
				<div class="space-y-1">
					<div class="text-base font-semibold">全部处理完毕</div>
					<div class="text-sm text-muted-foreground">
						{data.state === 'pending' ? '没有待审评论。' : '这里还没有记录。'}
					</div>
				</div>
			</div>
		</div>
	{:else}
		<form method="POST" action="?/review" class="flex min-h-0 flex-1 flex-col">
			<div class="min-h-0 flex-1 overflow-auto">
				{#each data.entries as entry (entry.id)}
					<label
						class="flex cursor-pointer items-start gap-3 border-b px-4 py-3.5 hover:bg-muted/50"
					>
						{#if data.state === 'pending'}
							<input type="checkbox" name="ids" value={entry.id} class="mt-1" />
						{:else}
							<span class="mt-1 w-3.5"></span>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span
									class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
								>
									{avatarText(entry.author)}
								</span>
								<span class="truncate text-sm font-medium">{entry.author ?? '匿名'}</span>
							</div>
							<p class="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">{entry.text}</p>
							<div
								class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/70"
							>
								<span class="inline-flex items-center gap-1">
									<IconClock class="size-3" />
									{formatDate(entry.createdAt)}
								</span>
								{#if entry.ip}
									<span class="inline-flex items-center gap-1">
										<IconGlobe class="size-3" />
										{entry.ip}
									</span>
								{/if}
								{#if entry.postSlug}
									<a
										class="inline-flex items-center gap-1 hover:underline"
										href={`/posts/${entry.postSlug}`}
										target="_blank"
										rel="noreferrer"
									>
										<IconExternalLink class="size-3" />
										<span class="max-w-64 truncate">{entry.postTitle}</span>
									</a>
								{:else if entry.postId}
									<span>博文 {entry.postId.slice(0, 8)}…</span>
								{:else}
									<span>其它目标</span>
								{/if}
								{#if entry.reviewedAt}
									<span>审于 {formatDate(entry.reviewedAt)}</span>
								{/if}
							</div>
						</div>
					</label>
				{/each}
			</div>

			{#if data.state === 'pending'}
				<div
					class="bg-surface-card flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3"
				>
					<Button type="submit" name="decision" value="approve" size="sm" class="gap-1">
						<IconCheck class="size-4" /> 通过
					</Button>
					<Button
						type="submit"
						name="decision"
						value="reject"
						variant="outline"
						size="sm"
						class="gap-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
					>
						<IconTrash class="size-4" /> 拒绝
					</Button>
				</div>
			{/if}
		</form>
	{/if}
</div>

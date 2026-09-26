<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Badge } from '$lib/components/ui/badge';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as Table from '$lib/components/ui/table';
	import * as MasterDetail from '$lib/components/admin/master-detail';
	import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArchive from '@tabler/icons-svelte-runes/icons/archive';
	import IconArchiveOff from '@tabler/icons-svelte-runes/icons/archive-off';
	import IconRobot from '@tabler/icons-svelte-runes/icons/robot';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	let { data, form }: PageProps = $props();

	type MemoryRow = PageProps['data']['memories'][number];

	const actionForm = $derived(
		form as {
			message?: string;
		} | null
	);

	const selected = $derived(data.conversations.find((c) => c.id === data.selectedId) ?? null);

	function switchTab(value: string | number) {
		const params = new SvelteURLSearchParams();
		const tab = String(value);
		if (tab !== 'conversations') params.set('tab', tab);
		if (tab === 'conversations' && data.selectedId) params.set('c', data.selectedId);
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	function formatDate(value: Date | string | null): string {
		if (!value) return '—';
		const date = value instanceof Date ? value : new Date(value);
		return date.toLocaleString('zh-CN', { hour12: false });
	}

	function formatNumber(value: number | null): string {
		if (value === null || value === undefined) return '—';
		return value.toLocaleString('zh-CN');
	}

	function formatCost(value: number | null): string {
		if (value === null || value === undefined) return '—';
		return value.toFixed(4);
	}

	/** Message payloads are jsonb; show the text when present, JSON otherwise. */
	function messageText(content: unknown): string {
		if (content && typeof content === 'object' && 'text' in content) {
			const text = (content as { text?: unknown }).text;
			if (typeof text === 'string') return text;
		}
		return typeof content === 'string' ? content : JSON.stringify(content ?? null);
	}

	const roleLabels: Record<string, string> = {
		system: '系统',
		user: '我',
		assistant: '助手',
		tool: '工具'
	};

	// ── Memory-card dialog state ────────────────────────────────────────
	let memoryDialogOpen = $state(false);
	let editingMemory = $state<MemoryRow | null>(null);
	let savingMemory = $state(false);
	let memoryContent = $state('');
	let deleteMemoryTarget = $state<MemoryRow | null>(null);

	function openMemoryCreate() {
		editingMemory = null;
		memoryContent = '';
		memoryDialogOpen = true;
	}

	function openMemoryEdit(memory: MemoryRow) {
		editingMemory = memory;
		memoryContent = memory.content;
		memoryDialogOpen = true;
	}
</script>

<svelte:head>
	<title>AI - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col gap-4 p-4">
	{#if actionForm?.message}
		<Alert.Root>
			<Alert.Title>{actionForm.message}</Alert.Title>
		</Alert.Root>
	{/if}

	<Tabs.Root value={data.tab} onValueChange={switchTab} class="min-h-0 flex-1">
		<Tabs.List class="w-fit">
			<Tabs.Trigger value="conversations">
				<IconMessages data-icon="inline-start" />
				对话台
			</Tabs.Trigger>
			<Tabs.Trigger value="memories">
				<IconBrain data-icon="inline-start" />
				记忆卡
			</Tabs.Trigger>
			<Tabs.Trigger value="usage">
				<IconChartBar data-icon="inline-start" />
				用量
			</Tabs.Trigger>
		</Tabs.List>

		<!-- ── 对话台 ─────────────────────────────────────────────────── -->
		<Tabs.Content value="conversations" class="min-h-0 flex-1">
			{#if data.conversations.length === 0}
				<Empty.Root class="h-full border">
					<Empty.Header>
						<Empty.Media variant="icon">
							<IconRobot />
						</Empty.Media>
						<Empty.Title>还没有对话</Empty.Title>
						<Empty.Description>
							管理对话随运行时批次接入；这里将展示会话、消息与线程摘要。
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<MasterDetail.Root>
					<MasterDetail.Pane side="master" class="w-80 shrink-0">
						<MasterDetail.Header
							icon={IconMessages}
							title="会话"
							count={data.conversations.length}
						/>
						<MasterDetail.List>
							{#each data.conversations as conversation (conversation.id)}
								<MasterDetail.Item
									selected={conversation.id === data.selectedId}
									onclick={() => goto(`?c=${conversation.id}`, { keepFocus: true, noScroll: true })}
								>
									<span class="min-w-0 flex-1">
										<span class="flex items-center gap-2">
											<span class="truncate text-sm font-medium">
												{conversation.title ?? '未命名会话'}
											</span>
											{#if conversation.archivedAt}
												<Badge variant="secondary">已归档</Badge>
											{/if}
										</span>
										<span class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
											<span>{conversation.messageCount} 条消息</span>
											<span>·</span>
											<span>{formatDate(conversation.updatedAt ?? conversation.createdAt)}</span>
										</span>
									</span>
								</MasterDetail.Item>
							{/each}
						</MasterDetail.List>
					</MasterDetail.Pane>
					<MasterDetail.Pane side="detail">
						{#if selected}
							<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
								<h2 class="truncate text-sm font-semibold">{selected.title ?? '未命名会话'}</h2>
								<form method="post" action="?/archiveConversation" use:enhance>
									<input type="hidden" name="id" value={selected.id} />
									<input
										type="hidden"
										name="archive"
										value={selected.archivedAt ? 'false' : 'true'}
									/>
									<Button type="submit" variant="outline" size="sm">
										{#if selected.archivedAt}
											<IconArchiveOff data-icon="inline-start" />
											取消归档
										{:else}
											<IconArchive data-icon="inline-start" />
											归档
										{/if}
									</Button>
								</form>
							</div>
							<div class="min-h-0 flex-1 overflow-auto p-4">
								{#if selected.summary}
									<Alert.Root class="mb-4">
										<Alert.Title>线程摘要</Alert.Title>
										<Alert.Description>{selected.summary}</Alert.Description>
									</Alert.Root>
								{/if}
								{#if data.messages.length === 0}
									<p class="text-sm text-muted-foreground">这个会话还没有消息。</p>
								{:else}
									<div class="flex flex-col gap-3">
										{#each data.messages as message (message.id)}
											<div class="rounded-lg border p-3">
												<div
													class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
												>
													<Badge variant={message.role === 'user' ? 'default' : 'secondary'}>
														{roleLabels[message.role] ?? message.role}
													</Badge>
													<span>#{message.seq}</span>
													{#if message.model}<span>{message.model}</span>{/if}
													<span>{formatDate(message.createdAt)}</span>
												</div>
												<p class="mt-2 text-sm whitespace-pre-wrap">
													{messageText(message.content)}
												</p>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{:else}
							<div class="flex h-full items-center justify-center p-6">
								<p class="text-sm text-muted-foreground">从左侧选择一个会话。</p>
							</div>
						{/if}
					</MasterDetail.Pane>
				</MasterDetail.Root>
			{/if}
		</Tabs.Content>

		<!-- ── 记忆卡 ─────────────────────────────────────────────────── -->
		<Tabs.Content value="memories" class="min-h-0 flex-1 overflow-auto">
			<div class="flex flex-col gap-4">
				<header class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h2 class="text-base font-medium">记忆卡</h2>
						<p class="mt-1 text-xs text-muted-foreground">
							助手长期携带的笔记（上限 {data.memoryLimit} 条，当前 {data.memories.length} 条）。
						</p>
					</div>
					<Button type="button" variant="outline" size="sm" onclick={openMemoryCreate}>
						<IconPlus data-icon="inline-start" />
						新建记忆卡
					</Button>
				</header>

				{#if data.memories.length === 0}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Media variant="icon">
								<IconBrain />
							</Empty.Media>
							<Empty.Title>还没有记忆卡</Empty.Title>
							<Empty.Description>记下长期偏好与背景，助手在对话中携带。</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2">
						{#each data.memories as memory (memory.id)}
							<div class="flex flex-col gap-3 rounded-lg border p-3">
								<p class="text-sm whitespace-pre-wrap">{memory.content}</p>
								<div class="mt-auto flex items-center justify-between gap-2">
									<span class="text-xs text-muted-foreground">{formatDate(memory.createdAt)}</span>
									<div class="flex items-center gap-2">
										<Button variant="outline" size="sm" onclick={() => openMemoryEdit(memory)}>
											<IconPencil data-icon="inline-start" />
											编辑
										</Button>
										<Button
											variant="destructive"
											size="sm"
											onclick={() => (deleteMemoryTarget = memory)}
										>
											<IconTrash data-icon="inline-start" />
											删除
										</Button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</Tabs.Content>

		<!-- ── 用量 ───────────────────────────────────────────────────── -->
		<Tabs.Content value="usage" class="min-h-0 flex-1 overflow-auto">
			<div class="flex flex-col gap-4">
				<header>
					<h2 class="text-base font-medium">用量</h2>
					<p class="mt-1 text-xs text-muted-foreground">按月、按功能聚合（读侧视图）。</p>
				</header>
				<Alert.Root>
					<Alert.Title>口径</Alert.Title>
					<Alert.Description>
						成本为估算值（OTel GenAI 语义，token 计费快照）；明细保留 24 个月，超限策略在「设定 →
						开关与阈值」。
					</Alert.Description>
				</Alert.Root>
				{#if data.usage.length === 0}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Media variant="icon">
								<IconChartBar />
							</Empty.Media>
							<Empty.Title>暂无用量记录</Empty.Title>
							<Empty.Description>接入运行时并产生调用后，这里按月汇总。</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>月份</Table.Head>
								<Table.Head>功能</Table.Head>
								<Table.Head class="text-right">调用</Table.Head>
								<Table.Head class="text-right">输入 tokens</Table.Head>
								<Table.Head class="text-right">输出 tokens</Table.Head>
								<Table.Head class="text-right">估算成本</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.usage as row (row.month + row.task)}
								<Table.Row>
									<Table.Cell>{row.month}</Table.Cell>
									<Table.Cell>
										<Badge variant="secondary">{row.task}</Badge>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{formatNumber(row.calls)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums"
										>{formatNumber(row.inputTokens)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums"
										>{formatNumber(row.outputTokens)}</Table.Cell
									>
									<Table.Cell class="text-right tabular-nums">{formatCost(row.cost)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</div>
		</Tabs.Content>
	</Tabs.Root>
</div>

<!-- ── Memory dialog ────────────────────────────────────────────────── -->
<Dialog.Root bind:open={memoryDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<form
			method="post"
			action="?/saveMemory"
			use:enhance={() => {
				savingMemory = true;
				return async ({ result, update }) => {
					savingMemory = false;
					if (result.type === 'success') memoryDialogOpen = false;
					await update({ reset: false });
				};
			}}
		>
			{#if editingMemory}
				<input type="hidden" name="id" value={editingMemory.id} />
			{/if}
			<div class="flex items-center justify-between gap-3 border-b px-4 pb-3">
				<Dialog.Title>{editingMemory ? '编辑记忆卡' : '新建记忆卡'}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-4 py-4">
				<Field.Group>
					<Field.Field>
						<Field.Label for="memory-content">内容</Field.Label>
						<Textarea
							id="memory-content"
							name="content"
							rows={5}
							bind:value={memoryContent}
							maxlength={2000}
							placeholder="例如：站点的语言默认 en，译文以 zh-cn 为准；写作时保留英文术语。"
						/>
					</Field.Field>
				</Field.Group>
			</div>
			<div class="flex items-center justify-end gap-2 border-t px-4 pt-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={savingMemory}>
					{#if savingMemory}<Spinner data-icon="inline-start" />{/if}
					保存
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- ── Memory delete confirm ────────────────────────────────────────── -->
<AlertDialog.Root
	open={deleteMemoryTarget !== null}
	onOpenChange={(open) => {
		if (!open) deleteMemoryTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>删除记忆卡</AlertDialog.Title>
			<AlertDialog.Description>
				将删除「{(deleteMemoryTarget?.content ?? '').slice(0, 40)}…」。此操作不可撤销。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form
				method="post"
				action="?/deleteMemory"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') deleteMemoryTarget = null;
						await update({ reset: false });
					}}
			>
				<input type="hidden" name="id" value={deleteMemoryTarget?.id ?? ''} />
				<Button type="submit" variant="destructive">删除</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

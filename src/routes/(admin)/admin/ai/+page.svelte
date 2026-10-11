<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
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
		system: m.admin_ai_role_system(),
		user: m.admin_ai_role_user(),
		assistant: m.admin_ai_role_assistant(),
		tool: m.admin_ai_role_tool()
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
				{m.admin_ai_tab_conversations()}
			</Tabs.Trigger>
			<Tabs.Trigger value="memories">
				<IconBrain data-icon="inline-start" />
				{m.admin_ai_tab_memories()}
			</Tabs.Trigger>
			<Tabs.Trigger value="usage">
				<IconChartBar data-icon="inline-start" />
				{m.admin_ai_tab_usage()}
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
						<Empty.Title>{m.admin_ai_no_conversations()}</Empty.Title>
						<Empty.Description>
							{m.admin_ai_conversations_desc()}
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<MasterDetail.Root>
					<MasterDetail.Pane side="master" class="w-80 shrink-0">
						<MasterDetail.Header
							icon={IconMessages}
							title={m.admin_ai_sessions_title()}
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
												{conversation.title ?? m.admin_ai_untitled_session()}
											</span>
											{#if conversation.archivedAt}
												<Badge variant="secondary">{m.admin_ai_archived()}</Badge>
											{/if}
										</span>
										<span class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
											<span>{m.admin_ai_message_count({ count: conversation.messageCount })}</span>
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
								<h2 class="truncate text-sm font-semibold">
									{selected.title ?? m.admin_ai_untitled_session()}
								</h2>
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
											{m.admin_ai_unarchive()}
										{:else}
											<IconArchive data-icon="inline-start" />
											{m.admin_ai_archive()}
										{/if}
									</Button>
								</form>
							</div>
							<div class="min-h-0 flex-1 overflow-auto p-4">
								{#if selected.summary}
									<Alert.Root class="mb-4">
										<Alert.Title>{m.admin_ai_summary()}</Alert.Title>
										<Alert.Description>{selected.summary}</Alert.Description>
									</Alert.Root>
								{/if}
								{#if data.messages.length === 0}
									<p class="text-sm text-muted-foreground">{m.admin_ai_no_messages()}</p>
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
								<p class="text-sm text-muted-foreground">{m.admin_ai_select_session()}</p>
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
						<h2 class="text-base font-medium">{m.admin_ai_tab_memories()}</h2>
						<p class="mt-1 text-xs text-muted-foreground">
							{m.admin_ai_memory_hint({ limit: data.memoryLimit, count: data.memories.length })}
						</p>
					</div>
					<Button type="button" variant="outline" size="sm" onclick={openMemoryCreate}>
						<IconPlus data-icon="inline-start" />
						{m.admin_ai_memory_new()}
					</Button>
				</header>

				{#if data.memories.length === 0}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Media variant="icon">
								<IconBrain />
							</Empty.Media>
							<Empty.Title>{m.admin_ai_memory_empty()}</Empty.Title>
							<Empty.Description>{m.admin_ai_memory_empty_desc()}</Empty.Description>
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
											{m.admin_common_edit()}
										</Button>
										<Button
											variant="destructive"
											size="sm"
											onclick={() => (deleteMemoryTarget = memory)}
										>
											<IconTrash data-icon="inline-start" />
											{m.admin_common_delete()}
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
					<h2 class="text-base font-medium">{m.admin_ai_tab_usage()}</h2>
					<p class="mt-1 text-xs text-muted-foreground">{m.admin_ai_usage_desc()}</p>
				</header>
				<Alert.Root>
					<Alert.Title>{m.admin_ai_usage_basis()}</Alert.Title>
					<Alert.Description>
						{m.admin_ai_usage_cost_note()}
					</Alert.Description>
				</Alert.Root>
				{#if data.usage.length === 0}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Media variant="icon">
								<IconChartBar />
							</Empty.Media>
							<Empty.Title>{m.admin_ai_usage_empty()}</Empty.Title>
							<Empty.Description>{m.admin_ai_usage_empty_desc()}</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>{m.admin_ai_col_month()}</Table.Head>
								<Table.Head>{m.admin_ai_col_task()}</Table.Head>
								<Table.Head class="text-right">{m.admin_ai_col_calls()}</Table.Head>
								<Table.Head class="text-right">{m.admin_ai_col_tokens_in()}</Table.Head>
								<Table.Head class="text-right">{m.admin_ai_col_tokens_out()}</Table.Head>
								<Table.Head class="text-right">{m.admin_ai_col_cost()}</Table.Head>
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
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
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
				<Dialog.Title
					>{editingMemory ? m.admin_ai_memory_edit() : m.admin_ai_memory_new()}</Dialog.Title
				>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							{...props}
							aria-label={m.admin_common_close()}
						>
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-4 py-4">
				<Field.Group>
					<Field.Field>
						<Field.Label for="memory-content">{m.admin_ai_memory_content()}</Field.Label>
						<Textarea
							id="memory-content"
							name="content"
							rows={5}
							bind:value={memoryContent}
							maxlength={2000}
							placeholder={m.admin_ai_memory_placeholder()}
						/>
					</Field.Field>
				</Field.Group>
			</div>
			<div class="flex items-center justify-end gap-2 border-t px-4 pt-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={savingMemory}>
					{#if savingMemory}<Spinner data-icon="inline-start" />{/if}
					{m.admin_common_save()}
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
			<AlertDialog.Title>{m.admin_ai_memory_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_ai_memory_delete_desc({
					preview: (deleteMemoryTarget?.content ?? '').slice(0, 40)
				})}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
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
				<Button type="submit" variant="destructive">{m.admin_common_delete()}</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

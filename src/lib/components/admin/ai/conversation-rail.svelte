<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';
	import { m } from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import { formatDateTime, type ConsoleConversation } from './console-view';
	import IconLayoutSidebarLeftCollapse from '@tabler/icons-svelte-runes/icons/layout-sidebar-left-collapse';
	import IconRobot from '@tabler/icons-svelte-runes/icons/robot';

	let {
		conversations,
		selectedId,
		locale,
		onSelect,
		onCollapse
	}: {
		conversations: ConsoleConversation[];
		selectedId: string | null;
		locale: string;
		onSelect: (id: string) => void;
		onCollapse?: () => void;
	} = $props();

	const active = $derived(conversations.filter((conversation) => !conversation.archivedAt));
	const archived = $derived(conversations.filter((conversation) => conversation.archivedAt));
</script>

<div class="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
	<div class="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-semibold">{m.admin_ai_sessions_title()}</p>
			<p class="truncate text-[11px] text-muted-foreground">
				{m.admin_ai_rail_count({ count: conversations.length })}
			</p>
		</div>
		{#if onCollapse}
			<Button
				variant="ghost"
				size="icon-sm"
				class="shrink-0 text-muted-foreground"
				aria-label={m.admin_ai_rail_collapse()}
				title={m.admin_ai_rail_collapse()}
				onclick={onCollapse}
			>
				<IconLayoutSidebarLeftCollapse />
			</Button>
		{/if}
	</div>

	{#if conversations.length === 0}
		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
			<Empty.Root class="border-dashed p-4">
				<Empty.Header>
					<Empty.Media variant="icon">
						<IconRobot />
					</Empty.Media>
					<Empty.Title>{m.admin_ai_no_conversations()}</Empty.Title>
					<Empty.Description>{m.admin_ai_conversations_desc()}</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		</div>
	{:else}
		<nav
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
			aria-label={m.admin_ai_sessions_title()}
		>
			{#each [{ key: 'active', label: m.admin_ai_rail_active(), rows: active }, { key: 'archived', label: m.admin_ai_rail_archived(), rows: archived }] as group (group.key)}
				{#if group.rows.length > 0}
					<section class="pb-1">
						<h2
							class="px-2 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase"
						>
							{group.label}
						</h2>
						<ul class="flex flex-col gap-0.5">
							{#each group.rows as conversation (conversation.id)}
								{@const selected = conversation.id === selectedId}
								<li>
									<button
										type="button"
										onclick={() => onSelect(conversation.id)}
										aria-current={selected ? 'page' : undefined}
										data-active={selected}
										class="group/row flex w-full items-start gap-2 rounded-lg px-2 py-2 text-start transition-colors outline-none hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
									>
										<span
											aria-hidden="true"
											class={cn(
												'mt-1.5 size-1.5 shrink-0 rounded-full',
												conversation.archivedAt ? 'border border-muted-foreground/40' : 'bg-primary'
											)}
										></span>
										<span class="flex min-w-0 flex-1 flex-col gap-0.5">
											<span class="flex min-w-0 items-center gap-1.5">
												<span class="min-w-0 truncate text-sm">
													{conversation.title ?? m.admin_ai_untitled_session()}
												</span>
												{#if conversation.archivedAt}
													<Badge variant="secondary" class="h-4 shrink-0 px-1 text-[10px]">
														{m.admin_ai_archived()}
													</Badge>
												{/if}
											</span>
											<span class="min-w-0 truncate text-[11px] text-muted-foreground">
												{m.admin_ai_message_count({ count: conversation.messageCount })} ·
												{formatDateTime(conversation.updatedAt ?? conversation.createdAt, locale)}
											</span>
										</span>
									</button>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/each}
		</nav>
	{/if}
</div>

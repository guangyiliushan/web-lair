<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import ConversationRail from '$lib/components/admin/ai/conversation-rail.svelte';
	import MessageItem from '$lib/components/admin/ai/message-item.svelte';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { messageByKey, readinessCopy, readinessTitle } from '$lib/utils/readiness-copy';
	import { getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let text = $state('');
	let busy = $state(false);
	let streamingText = $state('');
	let streamingTrace = $state<Array<{ title: string; status: string }>>([]);
	let streamError = $state('');
	const locale = getLocale();
	const actionForm = $derived(form as { message?: string } | null);
	const selected = $derived(
		data.conversations.find((conversation) => conversation.id === data.selectedId) ?? null
	);

	// Chat is one more function slot, so it answers to the same readiness gate as
	// the editors: pressable only when a model would actually run, and when it
	// cannot run the page names the reason instead of letting the first send fail.
	const chatReady = $derived(data.chatReadiness.status === 'ready');
	const readinessNotice = $derived(
		chatReady
			? null
			: readinessCopy(data.chatReadiness.status, { name: data.chatReadiness.envName ?? '' })
	);
	const composerTitle = $derived(readinessTitle(data.chatReadiness, m.admin_ai_chat_send_hint()));

	// The "新建" header button is declared in +page.server.ts; it submits the
	// hidden form below, so the POST path stays the same one the page used.
	const headerActions = useAdminHeaderActionRegistry();
	let newSessionForm = $state<HTMLFormElement | null>(null);
	$effect(() => headerActions?.register('chat:new', () => newSessionForm?.requestSubmit()));

	function selectConversation(id: string) {
		goto(`?c=${id}`, { keepFocus: true, noScroll: true });
	}

	async function sendStream() {
		if (!data.selectedId || !text.trim() || busy || !chatReady) return;
		busy = true;
		streamError = '';
		streamingText = '';
		streamingTrace = [];
		const sent = text;
		try {
			const response = await fetch('/api/admin/ai/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversationId: data.selectedId, text: sent })
			});
			if (!response.ok || !response.body) {
				throw new Error((await response.text()) || `HTTP ${response.status}`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split('\n\n');
				buffer = blocks.pop() ?? '';
				for (const block of blocks) {
					let event = 'message';
					let dataLine = '';
					for (const line of block.split('\n')) {
						if (line.startsWith('event:')) event = line.slice(6).trim();
						else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
					}
					if (!dataLine) continue;
					const payload = JSON.parse(dataLine) as Record<string, unknown>;
					if (event === 'delta' && typeof payload.text === 'string') {
						streamingText += payload.text;
					} else if (event === 'tool') {
						streamingTrace = [
							...streamingTrace,
							{
								title: String(payload.title ?? 'tool'),
								status: String(payload.status ?? 'succeeded')
							}
						];
					} else if (event === 'error') {
						throw new Error(String(payload.message ?? 'stream error'));
					}
				}
			}
			text = '';
			await invalidateAll();
		} catch (caught) {
			streamError = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = false;
			streamingText = '';
			streamingTrace = [];
		}
	}
</script>

<svelte:head>
	<title>{m.admin_ai_chat_title()}</title>
</svelte:head>

<div class="flex min-h-0 flex-1">
	<aside class="hidden w-72 shrink-0 border-r md:block">
		<ConversationRail
			conversations={data.conversations}
			selectedId={data.selectedId}
			{locale}
			onSelect={selectConversation}
		/>
	</aside>

	<section class="flex min-h-0 min-w-0 flex-1 flex-col">
		<!-- h-12 matches the conversation rail's header, so the two top bars share
		     one baseline and their borders land on the same line. -->
		<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
			<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">
				{selected?.title ?? m.admin_ai_chat_title()}
			</h1>
			{#if selected}
				{#if !selected.archivedAt}
					<form method="post" action="?/archive">
						<input type="hidden" name="id" value={selected.id} />
						<Button type="submit" variant="outline" size="sm">
							{m.admin_ai_chat_archive()}
						</Button>
					</form>
				{/if}
				<form
					method="post"
					action="?/delete"
					onsubmit={(event) => {
						if (!confirm(m.admin_ai_chat_delete_confirm())) event.preventDefault();
					}}
				>
					<input type="hidden" name="id" value={selected.id} />
					<Button type="submit" variant="destructive" size="sm">
						{m.admin_ai_chat_delete()}
					</Button>
				</form>
			{/if}
			<!-- Submit target for the header's `新建` button (see the action registry). -->
			<form method="post" action="?/new" bind:this={newSessionForm} class="hidden"></form>
		</header>

		{#if actionForm?.message}
			<p role="alert" class="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
				{actionForm.message}
			</p>
		{/if}

		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6">
			<div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
				{#if !data.selectedId}
					<div class="rounded-xl border border-dashed px-6 py-12 text-center">
						<p class="text-sm font-medium">{m.admin_ai_no_conversations()}</p>
						<p class="mt-2 text-xs text-muted-foreground">{m.admin_ai_chat_start_hint()}</p>
					</div>
				{:else if data.messages.length === 0}
					<div class="rounded-xl border border-dashed px-6 py-12 text-center">
						<p class="text-sm font-medium">{m.admin_ai_chat_empty()}</p>
						<p class="mt-2 text-xs text-muted-foreground">{m.admin_ai_chat_tools()}</p>
					</div>
				{:else}
					{#each data.messages as message (message.id)}
						<MessageItem {message} {locale} />
					{/each}
				{/if}
				{#if streamingTrace.length > 0 || streamingText}
					<div class="rounded-xl border bg-muted/20 p-3">
						{#each streamingTrace as step, index (index)}
							<div class="text-[11px] text-muted-foreground">
								{step.title} · {step.status}
							</div>
						{/each}
						{#if streamingText}
							<p class="mt-2 text-sm whitespace-pre-wrap">{streamingText}</p>
						{/if}
					</div>
				{/if}
				{#if streamError}
					<p role="alert" class="text-xs text-destructive">{streamError}</p>
				{/if}
			</div>
		</div>

		{#if data.proposals.length > 0}
			<div class="shrink-0 border-t px-3 py-2 sm:px-6">
				<div class="mx-auto flex w-full max-w-3xl flex-col gap-2">
					{#each data.proposals as proposal (proposal.id)}
						<div class="rounded-lg border p-3 text-xs">
							<p class="font-medium">{proposal.settingKey}</p>
							<pre
								class="mt-1 max-h-24 overflow-auto text-[11px] whitespace-pre-wrap text-muted-foreground">{JSON.stringify(
									{ before: proposal.before, after: proposal.after },
									null,
									2
								)}</pre>
							<div class="mt-2 flex gap-2">
								<form method="post" action="?/confirmProposal">
									<input type="hidden" name="id" value={proposal.id} />
									<Button type="submit" size="sm">{m.admin_ai_chat_confirm()}</Button>
								</form>
								<form method="post" action="?/rejectProposal">
									<input type="hidden" name="id" value={proposal.id} />
									<Button type="submit" size="sm" variant="outline">
										{m.admin_ai_chat_reject()}
									</Button>
								</form>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if readinessNotice}
			<!-- The reason the composer below cannot be used, stated once and
			     linked to the page that fixes it. Readiness is the same verdict the
			     settings page and /admin/ai show, so the three cannot disagree. -->
			<div
				class="flex shrink-0 items-center gap-2 border-t bg-muted/30 px-3 py-2 sm:px-6"
				data-testid="chat-readiness"
			>
				<div class="mx-auto flex w-full max-w-3xl items-center gap-2 text-xs">
					<IconAlertTriangle class="size-3.5 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1">{readinessNotice.hint}</span>
					{#if data.chatReadiness.fix}
						<Button variant="outline" size="sm" href={data.chatReadiness.fix.href}>
							{messageByKey(data.chatReadiness.fix.labelKey)}
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		<form
			method="post"
			action="?/send"
			class="shrink-0 border-t px-3 py-3 sm:px-6"
			onsubmit={(event) => {
				event.preventDefault();
				void sendStream();
			}}
		>
			<input type="hidden" name="conversationId" value={data.selectedId ?? ''} />
			<div class="mx-auto flex w-full max-w-3xl items-end gap-2">
				<Textarea
					name="text"
					bind:value={text}
					rows={2}
					disabled={!data.selectedId || busy || !chatReady}
					placeholder={m.admin_ai_composer_placeholder()}
					class="min-h-12 resize-none"
					aria-label={m.admin_ai_composer_placeholder()}
					title={composerTitle}
				/>
				<Button
					type="submit"
					disabled={!data.selectedId || busy || !chatReady || !text.trim()}
					title={composerTitle}
				>
					{m.admin_ai_send()}
				</Button>
			</div>
		</form>
	</section>
</div>

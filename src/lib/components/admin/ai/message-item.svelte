<script lang="ts">
	import * as Bubble from '$lib/components/ui/bubble';
	import * as Item from '$lib/components/ui/item';
	import * as Message from '$lib/components/ui/message';
	import * as Trace from '$lib/components/ui/trace';
	import { m } from '$lib/paraglide/messages';
	import { formatTime, type AiMessageRole, type ConsoleMessage } from './console-view';
	import IconCircleDashed from '@tabler/icons-svelte-runes/icons/circle-dashed';

	let { message, locale }: { message: ConsoleMessage; locale: string } = $props();

	const isUser = $derived(message.role === 'user');

	function roleLabel(role: AiMessageRole): string {
		switch (role) {
			case 'user':
				return m.admin_ai_role_user();
			case 'assistant':
				return m.admin_ai_role_assistant();
			case 'tool':
				return m.admin_ai_role_tool();
			default:
				return m.admin_ai_role_system();
		}
	}
</script>

<Message.Root align={isUser ? 'end' : 'start'} data-testid="ai-message">
	<Message.Content>
		<Message.Header class="gap-2 px-1">
			{roleLabel(message.role)}
			<span class="text-[11px] font-normal text-muted-foreground/70 tabular-nums">
				#{message.seq}
			</span>
			{#if message.model}
				<span class="hidden truncate text-[11px] font-normal text-muted-foreground/70 sm:inline">
					{message.model}
				</span>
			{/if}
		</Message.Header>

		{#if message.trace.length > 0}
			<Trace.Root class="hidden sm:flex">
				{#each message.trace as step, index (index)}
					<Trace.Line status={step.status}>
						<Trace.Icon>
							<IconCircleDashed />
						</Trace.Icon>
						<Trace.Title>{step.title}</Trace.Title>
						{#if step.description}
							<Trace.Description>{step.description}</Trace.Description>
						{/if}
					</Trace.Line>
				{/each}
			</Trace.Root>
		{/if}

		<Bubble.Root variant={isUser ? 'muted' : 'ghost'} align={isUser ? 'end' : 'start'}>
			<Bubble.Content class="whitespace-pre-wrap">{message.text}</Bubble.Content>
		</Bubble.Root>

		{#if message.citations.length > 0}
			<div class="hidden gap-2 pt-1 sm:grid sm:grid-cols-2">
				{#each message.citations as citation, index (index)}
					<Item.Root variant="outline" size="sm" class="items-start">
						<Item.Content>
							<Item.Title>{citation.title}</Item.Title>
							{#if citation.description}
								<Item.Description class="font-mono text-xs">
									{citation.description}
								</Item.Description>
							{/if}
						</Item.Content>
						{#if citation.href}
							<Item.Actions>
								<a
									href={citation.href}
									class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									{m.admin_ai_open()}
								</a>
							</Item.Actions>
						{/if}
					</Item.Root>
				{/each}
			</div>
		{/if}

		<Message.Footer class="hidden px-1 text-[11px] tabular-nums sm:flex">
			{formatTime(message.createdAt, locale)}
		</Message.Footer>
	</Message.Content>
</Message.Root>

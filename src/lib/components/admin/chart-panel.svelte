<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { cn } from '$lib/utils';
	import type { Component } from 'svelte';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		title: string;
		description?: string;
		icon?: Component;
		empty?: boolean;
		class?: string;
		children?: import('svelte').Snippet;
	}

	let {
		title,
		description,
		icon: Icon,
		empty = true,
		class: className,
		children
	}: Props = $props();
</script>

<Card.Root class={cn(className)}>
	<Card.Header>
		<div class="flex items-center gap-2">
			{#if Icon}
				<Icon class="size-4 text-muted-foreground" />
			{/if}
			<Card.Title class="text-sm font-medium">{title}</Card.Title>
		</div>
		{#if description}
			<Card.Description>{description}</Card.Description>
		{/if}
	</Card.Header>
	<Card.Content>
		{#if empty}
			<div class="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
				{m.admin_common_empty()}
			</div>
		{:else if children}
			{@render children()}
		{/if}
	</Card.Content>
</Card.Root>

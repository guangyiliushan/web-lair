<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { cn } from '$lib/utils';
	import type { Component, Snippet } from 'svelte';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		title: string;
		description?: string;
		icon?: Component;
		/** Rendered instead of the plot when the series is empty. */
		empty?: boolean;
		class?: string;
		children?: Snippet;
		/** Table-view twin: every plotted value must be readable without hover. */
		table?: Snippet;
	}

	let {
		title,
		description,
		icon: Icon,
		empty = false,
		class: className,
		children,
		table
	}: Props = $props();
</script>

<Card.Root class={cn('gap-3', className)}>
	<Card.Header class="gap-1 pb-0">
		<div class="flex items-center gap-2">
			{#if Icon}
				<Icon class="size-4 text-muted-foreground" aria-hidden="true" />
			{/if}
			<Card.Title class="text-sm font-medium">{title}</Card.Title>
		</div>
		{#if description}
			<Card.Description class="text-xs">{description}</Card.Description>
		{/if}
	</Card.Header>
	<Card.Content class="pb-3">
		{#if empty}
			<div class="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
				{m.admin_common_empty()}
			</div>
		{:else}
			{@render children?.()}
		{/if}

		{#if table && !empty}
			<details class="mt-2">
				<summary
					class="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{m.admin_dashboard_chart_table_toggle()}
				</summary>
				<div class="mt-2 overflow-x-auto">
					{@render table()}
				</div>
			</details>
		{/if}
	</Card.Content>
</Card.Root>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';

	interface FilterOption {
		/** Query-string value; `''` is the "all" entry that clears the filter. */
		value: string;
		label: string;
		/** Query string including the leading `?`, `''` for the unfiltered link. */
		search?: string;
	}

	interface Props {
		/** Route this filter belongs to, e.g. `/admin/posts`. */
		path: Pathname;
		/** Screen-reader name for the trigger, e.g. "Filter by status". */
		label: string;
		/** Label shown on the trigger. */
		current: string;
		/** Value of the applied filter, `''` when unfiltered. */
		selected?: string;
		options: FilterOption[];
	}

	let { path, label, current, selected = '', options }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				aria-label={label}
				class={cn(
					'h-7 w-full max-w-full min-w-0 justify-between gap-1 px-1 text-xs font-normal',
					selected
						? 'bg-primary/10 text-foreground hover:bg-primary/15'
						: 'text-muted-foreground hover:bg-muted hover:text-foreground'
				)}
			>
				<span class="truncate">{current}</span>
				<IconChevronDown class="size-3 shrink-0 opacity-70" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="max-h-80 w-56 overflow-y-auto">
		<DropdownMenu.Group>
			{#each options as option (option.value)}
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a
							href="{resolve(path)}{option.search ?? ''}"
							{...props}
							class="flex w-full items-center gap-2"
						>
							<span class="truncate">{option.label}</span>
							{#if option.value === selected}
								<IconCheck class="ml-auto size-3.5 shrink-0" />
							{/if}
						</a>
					{/snippet}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>

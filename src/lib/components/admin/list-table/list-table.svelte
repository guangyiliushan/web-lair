<script lang="ts" generics="T">
	import * as Table from '$lib/components/ui/table';
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import { listHeadClass, type ListColumn } from './list-column';

	interface Props {
		/** Column descriptors — the single source of truth for head and cell classes. */
		columns: ListColumn[];
		rows: readonly T[];
		rowKey: (item: T) => string;
		/**
		 * One `<Table.Row>` body per item, with its index (list rows that reorder
		 * need it for their dead zones). Cells must use `listColumnClass(col)` so
		 * they stay aligned with their `<th>`.
		 */
		row: Snippet<[T, number]>;
		/**
		 * Per-column header controls (search / filter / refresh), rendered in the
		 * same `<th>` as the data they drive — the alignment is structural, not
		 * something a spacer row has to approximate. The control replaces the
		 * label; the label stays as the cell's `sr-only` name.
		 */
		header?: Snippet<[ListColumn]>;
		/** Rendered in place of the body when there is nothing to list. */
		empty: Snippet;
		/** Row count + pager. */
		footer?: Snippet;
		/** Accessible name for the grid. */
		label?: string;
		class?: string;
	}

	let {
		columns,
		rows,
		rowKey,
		row,
		header,
		empty,
		footer,
		label,
		class: className
	}: Props = $props();
</script>

<div class={cn('flex min-w-0 flex-col', className)}>
	<Table.Root class="table-fixed" aria-label={label}>
		<Table.Header>
			<!-- Flat head: bare controls, no boxed chrome. -->
			<Table.Row class="border-b hover:bg-transparent">
				{#each columns as col (col.id)}
					<Table.Head
						class={cn(listHeadClass(col), 'h-10 text-xs font-normal text-muted-foreground')}
					>
						{#if col.control}
							<span class="sr-only">{col.label}</span>
							<div
								class={cn(
									'flex w-full min-w-0 items-center',
									col.align === 'right' && 'justify-end'
								)}
							>
								{@render header?.(col)}
							</div>
						{:else}
							{col.label}
						{/if}
					</Table.Head>
				{/each}
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#if rows.length === 0}
				<Table.Row class="hover:bg-transparent">
					<Table.Cell colspan={columns.length} class="p-0 whitespace-normal">
						{@render empty()}
					</Table.Cell>
				</Table.Row>
			{:else}
				{#each rows as item, index (rowKey(item))}
					<Table.Row class="align-middle">
						{@render row(item, index)}
					</Table.Row>
				{/each}
			{/if}
		</Table.Body>
	</Table.Root>
	{#if footer}{@render footer()}{/if}
</div>

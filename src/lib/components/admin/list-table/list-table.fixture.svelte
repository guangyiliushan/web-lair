<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import ListTable from './list-table.svelte';
	import { listColumnClass, type ListColumn } from './list-column';

	/**
	 * Spec fixture: mirrors how the admin list pages declare columns and fill
	 * cells, so the head/body class parity asserted in `list-table.svelte.spec`
	 * is the parity the real pages rely on.
	 */
	const cols = {
		title: { id: 'title', label: 'Title', control: true },
		status: {
			id: 'status',
			label: 'Status',
			width: 'w-28',
			hideBelow: 'md',
			control: true
		},
		views: { id: 'views', label: 'Views', width: 'w-20', hideBelow: 'xl', align: 'right' },
		actions: {
			id: 'actions',
			label: 'Actions',
			width: 'w-28',
			align: 'right',
			control: true
		}
	} satisfies Record<string, ListColumn>;

	const columns = Object.values(cols);

	interface Row {
		id: string;
		title: string;
		status: string;
		views: number;
	}

	let { rows = [] as Row[] }: { rows?: Row[] } = $props();
</script>

<ListTable {columns} {rows} rowKey={(item) => item.id} label="Spec list">
	{#snippet header(col)}
		{#if col.id === 'title'}
			<input data-testid="search" />
		{:else if col.id === 'status'}
			<button data-testid="filter">filter</button>
		{:else if col.id === 'actions'}
			<button data-testid="refresh">refresh</button>
		{/if}
	{/snippet}

	{#snippet row(item)}
		<Table.Cell class="{listColumnClass(cols.title)} whitespace-normal">{item.title}</Table.Cell>
		<Table.Cell class={listColumnClass(cols.status)}>{item.status}</Table.Cell>
		<Table.Cell class={listColumnClass(cols.views)}>{item.views}</Table.Cell>
		<Table.Cell class={listColumnClass(cols.actions)}>actions</Table.Cell>
	{/snippet}

	{#snippet empty()}
		<p data-testid="empty">Nothing here</p>
	{/snippet}
</ListTable>

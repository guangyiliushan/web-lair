<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ListRowActions from './list-row-actions.svelte';

	/**
	 * Two callers of `ListRowActions` exercise the two halves of the `primary`
	 * contract: friends carries a status action *and* edit, files carries only
	 * the download. `edit` switches the edit button on so the spec can tell
	 * whether `primary` suppresses it.
	 */
	let { edit = true }: { edit?: boolean } = $props();
</script>

<ListRowActions
	editLabel={edit ? 'Edit' : undefined}
	onEdit={() => {}}
	deleteLabel="Delete"
	onDelete={() => {}}
>
	{#snippet primary()}
		<Button variant="ghost" size="sm" data-testid="extra">Approve</Button>
	{/snippet}
</ListRowActions>

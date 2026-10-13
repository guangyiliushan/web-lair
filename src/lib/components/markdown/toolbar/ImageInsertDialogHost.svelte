<script lang="ts">
	// Test host (pattern: ToolbarTestHost.svelte): owns `open` so specs can
	// close and reopen the dialog - the dialog itself only closes through
	// its bindable.
	import ImageInsertDialog from './ImageInsertDialog.svelte';

	let {
		onInsert
	}: {
		onInsert: (url: string, alt: string, tailAttrs: string) => void;
	} = $props();
	let open = $state(false);
</script>

<button type="button" onclick={() => (open = true)}>open-picker</button>
<ImageInsertDialog bind:open {onInsert} />

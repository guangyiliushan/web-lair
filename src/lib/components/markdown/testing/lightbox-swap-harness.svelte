<script lang="ts">
	import MarkdownRenderer from '../editor/MarkdownRenderer.svelte';

	// Testing fixture (review 3d): toggles MarkdownRenderer's `html` prop
	// between two documents so a spec can swap the article while the lightbox
	// is open. Drive it with a programmatic click - the modal dialog blocks
	// pointer hit-testing on purpose.
	import { untrack } from 'svelte';

	let { htmlA, htmlB }: { htmlA: string; htmlB: string } = $props();
	// Initial capture only; untrack documents the intent (silences
	// state_referenced_locally, house pattern).
	let current = $state(untrack(() => htmlA));
</script>

<button type="button" onclick={() => (current = current === htmlA ? htmlB : htmlA)}>swap</button>
<MarkdownRenderer html={current} />

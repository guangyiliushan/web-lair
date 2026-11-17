<script lang="ts">
	import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';

	let { initial, next }: { initial: string; next: string } = $props();
	// Deliberate: the fixture seeds its state once so a swap can be observed.
	// svelte-ignore state_referenced_locally (prop value captured once by design)
	let source = $state(initial);
</script>

<button type="button" data-swap onclick={() => (source = next)}>swap</button>
<MarkdownRenderer {source} />

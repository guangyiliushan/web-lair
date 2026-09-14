<script lang="ts">
	// Test host: mirrors the posts/edit page structure the editor relies on —
	// a Tooltip.Provider from the root layout and a fixed-height flex chain
	// (h-screen > flex-col > flex-1 min-h-0) that lets the editor fill the
	// remaining viewport space.
	import { Provider as TooltipProvider } from '../../ui/tooltip/index.js';
	import MarkdownEditor from '../editor/MarkdownEditor.svelte';

	let {
		initialMarkdown = '',
		placeholder = '输入正文...'
	}: { initialMarkdown?: string; placeholder?: string } = $props();
</script>

<TooltipProvider>
	<div class="flex h-screen min-h-0 w-full flex-col px-3">
		<MarkdownEditor {initialMarkdown} {placeholder} showToolbar stickyToolbar={false} class="min-h-0 flex-1" />
	</div>
</TooltipProvider>

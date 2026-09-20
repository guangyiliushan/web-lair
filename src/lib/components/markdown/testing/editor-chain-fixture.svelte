<script lang="ts">
	// Test host for the full editor chain: mirrors the production flex chain
	// (Tooltip provider + h-screen > flex-col) and surfaces the serialised
	// markdown into the DOM after every change, so specs can assert the
	// edit → WYSIWYG → save path without touching the component instance.
	import { Provider as TooltipProvider } from '../../ui/tooltip/index.js';
	import MarkdownEditor from '../editor/MarkdownEditor.svelte';

	let { initialMarkdown = '' }: { initialMarkdown?: string } = $props();
	let latest = $state('');
</script>

<TooltipProvider>
	<div class="flex h-screen min-h-0 w-full flex-col px-3">
		<MarkdownEditor
			{initialMarkdown}
			placeholder="输入正文..."
			showToolbar
			stickyToolbar={false}
			class="min-h-0 flex-1"
			onChange={(detail) => (latest = detail.markdown)}
		/>
	</div>
</TooltipProvider>

<output data-latest-markdown>{latest}</output>

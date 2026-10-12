<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconBug from '@tabler/icons-svelte-runes/icons/bug';
	import { m } from '$lib/paraglide/messages';

	type Props = {
		open: boolean;
		editorStateJson: string;
	};

	let { open = $bindable(), editorStateJson }: Props = $props();

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(editorStateJson);
		} catch {
			// The clipboard API may be unavailable in non-HTTPS contexts
		}
	}

	function handleDownload() {
		const blob = new Blob([editorStateJson], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `lexical-state-${new Date().toISOString().replaceAll(':', '-')}.json`;
		document.body.append(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-2xl">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconBug class="size-4" />
					{m.editor_debug_title()}
				</Dialog.Title>
				<Dialog.Description>{m.editor_debug_desc()}</Dialog.Description>
			</Dialog.Header>

			<div class="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-4">
				<pre
					class="font-mono text-xs leading-relaxed whitespace-pre text-foreground">{editorStateJson}</pre>
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={handleDownload}>
					<IconDownload data-icon="inline-start" />
					{m.editor_debug_download()}
				</Button>
				<Button onclick={handleCopy}>
					<IconCopy data-icon="inline-start" />
					{m.editor_debug_copy()}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

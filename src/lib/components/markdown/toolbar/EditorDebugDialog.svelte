<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconBug from '@tabler/icons-svelte-runes/icons/bug';

	type Props = {
		open: boolean;
		editorStateJson: string;
	};

	let { open = $bindable(), editorStateJson }: Props = $props();

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(editorStateJson);
		} catch {
			// 剪贴板 API 可能在非 HTTPS 环境不可用
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
					调试 · Editor State
				</Dialog.Title>
				<Dialog.Description>当前 Lexical 编辑器状态的 JSON 序列化输出。</Dialog.Description>
			</Dialog.Header>

			<div class="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-4">
				<pre
					class="font-mono text-xs leading-relaxed whitespace-pre text-foreground">{editorStateJson}</pre>
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={handleDownload}>
					<IconDownload data-icon="inline-start" />
					下载
				</Button>
				<Button onclick={handleCopy}>
					<IconCopy data-icon="inline-start" />
					复制
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

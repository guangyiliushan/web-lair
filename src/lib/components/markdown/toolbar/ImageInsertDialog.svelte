<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';

	type Props = {
		open: boolean;
		onInsert: (url: string, alt: string) => void;
	};

	let { open = $bindable(), onInsert }: Props = $props();

	let url = $state('');
	let alt = $state('');
	let previewFailed = $state(false);

	const canInsert = $derived(
		url.trim().length > 0 && /^(https?:\/\/|data:image\/|\/)/.test(url.trim())
	);

	// URL 变化时重置预览失败状态
	$effect(() => {
		void url;
		previewFailed = false;
	});

	// 打开时重置表单
	$effect(() => {
		if (open) {
			url = '';
			alt = '';
			previewFailed = false;
		}
	});

	function handleInsert() {
		if (!canInsert) return;
		onInsert(url.trim(), alt.trim());
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconPhoto class="size-4" />
					插入图片
				</Dialog.Title>
				<Dialog.Description>输入图片地址，编辑器内将直接渲染预览。</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label for="image-url">图片地址</Label>
					<Input
						id="image-url"
						placeholder="https://example.com/image.png"
						bind:value={url}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleInsert();
							}
						}}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="image-alt">图片描述（可选）</Label>
					<Input
						id="image-alt"
						placeholder="描述这张图片"
						bind:value={alt}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleInsert();
							}
						}}
					/>
				</div>
				{#if url.trim() && !previewFailed}
					<div
						class="flex max-h-48 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/30 p-2"
					>
						<img
							src={url.trim()}
							{alt}
							class="max-h-40 max-w-full rounded object-contain"
							onerror={() => (previewFailed = true)}
						/>
					</div>
				{:else if previewFailed}
					<p class="text-xs text-muted-foreground">预览加载失败，请检查图片地址是否有效。</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>取消</Button>
				<Button disabled={!canInsert} onclick={handleInsert}>
					<IconPhoto data-icon="inline-start" />
					插入
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

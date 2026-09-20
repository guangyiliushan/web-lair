<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import { m } from '$lib/paraglide/messages';

	type Props = {
		open: boolean;
		onInsert: (url: string, alt: string) => void;
	};

	let { open = $bindable(), onInsert }: Props = $props();

	let url = $state('');
	let alt = $state('');
	/** The URL whose preview last failed — derived state instead of an $effect. */
	let failedUrl = $state<string | null>(null);

	const previewUrl = $derived(url.trim());
	const previewFailed = $derived(previewUrl !== '' && failedUrl === previewUrl);
	const canInsert = $derived(
		previewUrl.length > 0 && /^(https?:\/\/|data:image\/|\/)/.test(previewUrl)
	);

	function reset() {
		url = '';
		alt = '';
		failedUrl = null;
	}

	// Reset through the CLOSE path (escape / overlay / close button / insert):
	// bits-ui only fires onOpenChange for its own close paths, never for a
	// programmatic open from the toolbar.
	function handleOpenChange(next: boolean) {
		if (!next) reset();
	}

	function handleInsert() {
		if (!canInsert) return;
		onInsert(url.trim(), alt.trim());
		reset();
		open = false;
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconPhoto class="size-4" />
					{m.image_dialog_title()}
				</Dialog.Title>
				<Dialog.Description>{m.image_dialog_description()}</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label for="image-url">{m.image_url_label()}</Label>
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
					<Label for="image-alt">{m.image_alt_label()}</Label>
					<Input
						id="image-alt"
						placeholder={m.image_alt_placeholder()}
						bind:value={alt}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleInsert();
							}
						}}
					/>
				</div>
				{#if previewUrl && !previewFailed}
					<div
						class="flex max-h-48 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/30 p-2"
					>
						<img
							src={previewUrl}
							{alt}
							class="max-h-40 max-w-full rounded object-contain"
							onerror={() => (failedUrl = previewUrl)}
							onload={() => (failedUrl = null)}
						/>
					</div>
				{:else if previewFailed}
					<p class="text-xs text-muted-foreground">{m.image_preview_failed()}</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{m.image_cancel()}</Button>
				<Button disabled={!canInsert} onclick={handleInsert}>
					<IconPhoto data-icon="inline-start" />
					{m.image_insert()}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Spinner } from '$lib/components/ui/spinner';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import { m } from '$lib/paraglide/messages';
	import {
		EDITOR_UPLOADS_ENDPOINT as ENDPOINT,
		EditorUploadError,
		altFromName,
		tailAttrsOf,
		uploadEditorImage,
		type PickerItem
	} from '$lib/media/editor-uploads';
	import { uploadErrorCopy } from '$lib/components/markdown/editor/upload-feedback';

	type Tab = 'url' | 'photos' | 'files';
	type PickerSource = 'photos' | 'files';

	type Props = {
		open: boolean;
		/** tailAttrs = inner `{...}` text for `![...](...) {...}` (Q11); '' when unknown. */
		onInsert: (url: string, alt: string, tailAttrs: string) => void;
	};

	let { open = $bindable(), onInsert }: Props = $props();

	let tab = $state<Tab>('url');
	let urlInput = $state<HTMLInputElement | null>(null);

	// ── URL tab (unchanged behaviour) ──
	let url = $state('');
	let alt = $state('');
	/** The URL whose preview last failed — derived state instead of an $effect. */
	let failedUrl = $state<string | null>(null);

	const previewUrl = $derived(url.trim());
	const previewFailed = $derived(previewUrl !== '' && failedUrl === previewUrl);
	const canInsert = $derived(
		previewUrl.length > 0 && /^(https?:\/\/|data:image\/|\/)/.test(previewUrl)
	);

	// ── Picker tabs (photos / assets) ──
	let query = $state('');
	let items = $state<PickerItem[]>([]);
	let listState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	let uploadState = $state<'idle' | 'uploading' | 'error'>('idle');
	let uploadError = $state<string | null>(null);
	let uploadSkipped = $state(0);
	let failedThumbs = $state<string[]>([]);
	let fileInput = $state<HTMLInputElement | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	/** Stale-response guards: newest request wins; close invalidates uploads. */
	let listToken = 0;
	let uploadBatch = 0;

	// ── Actions ──

	async function loadList() {
		if (tab === 'url') return;
		const token = ++listToken;
		listState = 'loading';
		items = [];
		failedThumbs = [];
		try {
			const suffix = query.trim() !== '' ? `&q=${encodeURIComponent(query.trim())}` : '';
			const response = await fetch(`${ENDPOINT}?source=${tab}${suffix}`, {
				headers: { accept: 'application/json' }
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { items?: PickerItem[] };
			if (token !== listToken) return; // a newer request already won
			items = body.items ?? [];
			listState = 'ready';
		} catch {
			if (token !== listToken) return;
			items = [];
			listState = 'failed';
		}
	}

	function switchTab(next: Tab) {
		if (tab === next) return;
		tab = next;
		uploadState = 'idle';
		uploadError = null;
		uploadSkipped = 0;
		clearSearchTimer();
		if (next !== 'url') void loadList();
	}

	function handleTabChange(value: string) {
		if (value === 'url' || value === 'photos' || value === 'files') switchTab(value);
	}

	function clearSearchTimer() {
		if (searchTimer !== null) {
			clearTimeout(searchTimer);
			searchTimer = null;
		}
	}

	function handleSearchInput() {
		clearSearchTimer();
		searchTimer = setTimeout(() => void loadList(), 300);
	}

	/** Every programmatic close funnels through here so state always resets
	 *  (bits-ui's own close paths land in handleOpenChange below). */
	function closeDialog() {
		reset();
		open = false;
	}

	function handleInsertUrl() {
		if (!canInsert) return;
		onInsert(url.trim(), alt.trim(), '');
		closeDialog();
	}

	/** A picker click is a single deliberate choice: insert and close. */
	function insertItem(item: PickerItem) {
		if (!open) return; // a double click must not insert twice
		onInsert(item.previewUrl, altFromName(item.name), tailAttrsOf(item));
		closeDialog();
	}

	async function handleUpload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = ''; // allow re-selecting the same file
		if (files.length === 0) return;
		const batch = ++uploadBatch;
		uploadState = 'uploading';
		uploadError = null;
		uploadSkipped = 0;
		let failed = false;
		let processed = 0;
		for (const file of files) {
			try {
				processed += 1;
				const result = await uploadEditorImage(file);
				if (batch !== uploadBatch) return; // the dialog closed mid-batch
				// Uploads insert immediately; the dialog stays open so a batch
				// can continue - each success lands at the caret.
				onInsert(result.url, altFromName(file.name), tailAttrsOf(result));
			} catch (error) {
				if (batch !== uploadBatch) return;
				failed = true;
				uploadState = 'error';
				uploadError = error instanceof EditorUploadError ? error.code : 'network';
				// Files after the failure are skipped; say so instead of
				// dropping them silently (review round 2).
				uploadSkipped = files.length - processed;
				break;
			}
		}
		if (batch !== uploadBatch) return;
		if (!failed) uploadState = 'idle';
		void loadList(); // surface the fresh uploads (partial batches included)
	}

	function reset() {
		// Invalidate any in-flight batch: a closed dialog stops inserting.
		uploadBatch += 1;
		clearSearchTimer();
		url = '';
		alt = '';
		failedUrl = null;
		tab = 'url';
		query = '';
		items = [];
		failedThumbs = [];
		listState = 'idle';
		uploadState = 'idle';
		uploadError = null;
		uploadSkipped = 0;
	}

	// Reset through the CLOSE path: bits-ui fires onOpenChange for its own
	// close paths (escape / overlay / close button); the dialog's own
	// programmatic closes go through closeDialog() so every path resets.
	function handleOpenChange(next: boolean) {
		if (!next) reset();
	}
</script>

{#snippet pickerPane(source: PickerSource)}
	<div class="flex flex-col gap-3">
		<Input
			placeholder={m.image_search_placeholder()}
			aria-label={m.image_search_placeholder()}
			bind:value={query}
			oninput={handleSearchInput}
		/>
		{#if listState === 'failed'}
			<p role="alert" class="py-8 text-center text-sm text-destructive">
				{m.image_list_failed()}
			</p>
		{:else if listState === 'ready' && items.length === 0}
			<!-- Plain paragraphs rather than ui/empty: the Empty box is
			     oversized inside this dialog (3a review round 1). -->
			<p class="py-8 text-center text-sm text-muted-foreground">
				{query.trim() !== ''
					? m.image_search_empty()
					: source === 'photos'
						? m.image_photos_empty()
						: m.image_assets_empty()}
			</p>
		{:else if listState === 'loading' && items.length === 0}
			<div class="flex justify-center py-8">
				<Spinner class="size-5" aria-label={m.image_loading()} />
			</div>
		{:else}
			<ul
				aria-busy={listState === 'loading'}
				class="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1"
			>
				{#each items as item (item.id)}
					<li>
						<button
							type="button"
							class="w-full overflow-hidden rounded-md border border-border text-left transition-colors hover:border-primary/50"
							title={item.name}
							aria-label={item.name}
							onclick={() => insertItem(item)}
						>
							{#if failedThumbs.includes(item.id)}
								<div class="flex aspect-square w-full items-center justify-center bg-muted">
									<IconPhoto class="size-5 text-muted-foreground" />
								</div>
							{:else}
								<img
									src={item.url}
									alt=""
									loading="lazy"
									class="aspect-square w-full bg-muted object-cover"
									onerror={() => (failedThumbs = [...failedThumbs, item.id])}
								/>
							{/if}
							<span class="block truncate px-1 py-1 text-xs text-muted-foreground">{item.name}</span
							>
						</button>
					</li>
				{/each}
			</ul>
			{#if source === 'photos'}
				<p class="text-xs text-muted-foreground">{m.image_photos_hint()}</p>
			{/if}
		{/if}
		{#if source === 'files'}
			<div class="flex items-center gap-3 border-t border-border pt-3">
				<input
					bind:this={fileInput}
					type="file"
					accept="image/*"
					multiple
					class="sr-only"
					aria-label={m.image_upload_button()}
					tabindex={-1}
					onchange={handleUpload}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={uploadState === 'uploading'}
					onclick={() => fileInput?.click()}
				>
					{m.image_upload_button()}
				</Button>
				{#if uploadState === 'uploading'}
					<span role="status" class="text-xs text-muted-foreground">{m.image_uploading()}</span>
				{:else if uploadState === 'error'}
					<span role="status" class="text-xs text-destructive">
						{uploadErrorCopy(uploadError)}
					</span>
					{#if uploadSkipped > 0}
						<span role="status" class="text-xs text-muted-foreground">
							{m.image_upload_skipped({ count: uploadSkipped })}
						</span>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content
			class="sm:max-w-2xl"
			onOpenAutoFocus={(event) => {
				// The URL field is the keyboard entry path; bits-ui would
				// otherwise focus the first tabbable (the first tab trigger).
				event.preventDefault();
				urlInput?.focus();
			}}
		>
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconPhoto class="size-4" />
					{m.image_dialog_title()}
				</Dialog.Title>
				<Dialog.Description>{m.image_dialog_description()}</Dialog.Description>
			</Dialog.Header>

			<Tabs.Root value={tab} onValueChange={handleTabChange} class="flex min-h-72 flex-col gap-4">
				<Tabs.List class="grid w-full grid-cols-3">
					<Tabs.Trigger value="url">{m.image_tab_url()}</Tabs.Trigger>
					<Tabs.Trigger value="photos">{m.image_tab_photos()}</Tabs.Trigger>
					<Tabs.Trigger value="files">{m.image_tab_assets()}</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="url" class="flex flex-col gap-4">
					<div class="flex flex-col gap-2">
						<Label for="image-url">{m.image_url_label()}</Label>
						<Input
							id="image-url"
							bind:ref={urlInput}
							placeholder="https://example.com/image.png"
							bind:value={url}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									handleInsertUrl();
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
									handleInsertUrl();
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
				</Tabs.Content>
				<Tabs.Content value="photos">{@render pickerPane('photos')}</Tabs.Content>
				<Tabs.Content value="files">{@render pickerPane('files')}</Tabs.Content>
			</Tabs.Root>

			<Dialog.Footer>
				<Button variant="outline" onclick={closeDialog}>{m.image_cancel()}</Button>
				{#if tab === 'url'}
					<Button disabled={!canInsert} onclick={handleInsertUrl}>
						<IconPhoto data-icon="inline-start" />
						{m.image_insert()}
					</Button>
				{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Spinner } from '$lib/components/ui/spinner';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import { m } from '$lib/paraglide/messages';

	/** Picker item as served by the editor-uploads endpoint (3a2). */
	interface PickerItem {
		id: string;
		name: string;
		url: string;
		previewUrl: string;
		fullUrl: string;
		width: number | null;
		height: number | null;
		mimeType: string;
		byteSize: number;
		createdAt: string;
	}

	type Tab = 'url' | 'photos' | 'files';

	const TABS = ['url', 'photos', 'files'] as const;

	type Props = {
		open: boolean;
		onInsert: (url: string, alt: string) => void;
		/** Same-origin endpoint backing the picker list + uploads (3a1/3a2). */
		endpoint?: string;
	};

	let { open = $bindable(), onInsert, endpoint = '/admin/editor-uploads' }: Props = $props();

	// Tabs are hand-rolled: the repo ships no ui/tabs component and the
	// admin queue's plain tablist buttons are the house precedent.
	let tab = $state<Tab>('url');

	function tabLabel(id: Tab): string {
		return id === 'url'
			? m.image_tab_url()
			: id === 'photos'
				? m.image_tab_photos()
				: m.image_tab_assets();
	}

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
	let fileInput = $state<HTMLInputElement | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Actions ──

	async function loadList() {
		if (tab === 'url') return;
		listState = 'loading';
		try {
			const suffix = query.trim() !== '' ? `&q=${encodeURIComponent(query.trim())}` : '';
			const response = await fetch(`${endpoint}?source=${tab}${suffix}`, {
				headers: { accept: 'application/json' }
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { items?: PickerItem[] };
			items = body.items ?? [];
			listState = 'ready';
		} catch {
			items = [];
			listState = 'failed';
		}
	}

	function switchTab(next: Tab) {
		if (tab === next) return;
		tab = next;
		uploadState = 'idle';
		uploadError = null;
		if (next !== 'url') void loadList();
	}

	function handleSearchInput() {
		if (searchTimer !== null) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void loadList(), 300);
	}

	/** "cover.png" → "cover"; slugs pass through unchanged. */
	function altFromName(name: string): string {
		return name.replace(/\.[a-z0-9]{1,10}$/i, '');
	}

	function handleInsertUrl() {
		if (!canInsert) return;
		onInsert(url.trim(), alt.trim());
		reset();
		open = false;
	}

	/** A picker click is a single deliberate choice: insert and close. */
	function insertItem(item: PickerItem) {
		onInsert(item.previewUrl, altFromName(item.name));
		reset();
		open = false;
	}

	async function handleUpload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = ''; // allow re-selecting the same file
		if (files.length === 0) return;
		uploadState = 'uploading';
		uploadError = null;
		for (const file of files) {
			try {
				const form = new FormData();
				form.set('file', file);
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { accept: 'application/json' },
					body: form
				});
				const body = (await response.json().catch(() => null)) as {
					url?: string;
					code?: string;
				} | null;
				if (!response.ok || !body?.url) {
					uploadState = 'error';
					uploadError = body?.code ?? `HTTP ${response.status}`;
					return;
				}
				// Uploads insert immediately; the dialog stays open so a batch
				// can continue - each success lands at the caret.
				onInsert(body.url, altFromName(file.name));
			} catch {
				uploadState = 'error';
				uploadError = 'network';
				return;
			}
		}
		uploadState = 'idle';
		void loadList(); // surface the fresh uploads in the list
	}

	function reset() {
		url = '';
		alt = '';
		failedUrl = null;
		tab = 'url';
		query = '';
		items = [];
		listState = 'idle';
		uploadState = 'idle';
		uploadError = null;
	}

	// Reset through the CLOSE path (escape / overlay / close button / insert):
	// bits-ui only fires onOpenChange for its own close paths, never for a
	// programmatic open from the toolbar.
	function handleOpenChange(next: boolean) {
		if (!next) reset();
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-2xl">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<IconPhoto class="size-4" />
					{m.image_dialog_title()}
				</Dialog.Title>
				<Dialog.Description>{m.image_dialog_description()}</Dialog.Description>
			</Dialog.Header>

			<div class="flex min-h-72 flex-col gap-4">
				<div role="tablist" class="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-sm">
					{#each TABS as id (id)}
						<button
							type="button"
							role="tab"
							aria-selected={tab === id}
							class="rounded-md px-3 py-1.5 transition-colors {tab === id
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'}"
							onclick={() => switchTab(id)}
						>
							{tabLabel(id)}
						</button>
					{/each}
				</div>

				{#if tab === 'url'}
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
					</div>
				{:else}
					<div class="flex flex-col gap-3">
						<Input
							placeholder={m.image_search_placeholder()}
							aria-label={m.image_search_placeholder()}
							bind:value={query}
							oninput={handleSearchInput}
						/>
						{#if listState === 'failed'}
							<p class="py-8 text-center text-sm text-destructive">{m.image_list_failed()}</p>
						{:else if listState === 'ready' && items.length === 0}
							<p class="py-8 text-center text-sm text-muted-foreground">
								{tab === 'photos' ? m.image_photos_empty() : m.image_assets_empty()}
							</p>
						{:else if listState === 'loading' && items.length === 0}
							<div class="flex justify-center py-8"><Spinner class="size-5" /></div>
						{:else}
							<ul class="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1">
								{#each items as item (item.id)}
									<li>
										<button
											type="button"
											class="w-full overflow-hidden rounded-md border border-border text-left transition-colors hover:border-primary/50"
											title={item.name}
											aria-label={item.name}
											onclick={() => insertItem(item)}
										>
											<img
												src={item.url}
												alt=""
												loading="lazy"
												class="aspect-square w-full bg-muted object-cover"
											/>
											<span class="block truncate px-1 py-1 text-xs text-muted-foreground"
												>{item.name}</span
											>
										</button>
									</li>
								{/each}
							</ul>
							{#if tab === 'photos'}
								<p class="text-xs text-muted-foreground">{m.image_photos_hint()}</p>
							{/if}
						{/if}
						{#if tab === 'files'}
							<div class="flex items-center gap-3 border-t border-border pt-3">
								<input
									bind:this={fileInput}
									type="file"
									accept="image/*"
									multiple
									class="sr-only"
									onchange={handleUpload}
								/>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={() => fileInput?.click()}
								>
									{m.image_upload_button()}
								</Button>
								{#if uploadState === 'uploading'}
									<span class="text-xs text-muted-foreground">{m.image_uploading()}</span>
								{:else if uploadState === 'error'}
									<span class="text-xs text-destructive"
										>{m.image_upload_failed({ name: uploadError ?? '' })}</span
									>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{m.image_cancel()}</Button>
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

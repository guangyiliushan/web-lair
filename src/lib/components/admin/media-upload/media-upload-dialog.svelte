<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Attachment from '$lib/components/ui/attachment';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as FileDropzone from '$lib/components/ui/file-dropzone';
	import { applyUploadResults, mapUploadError, uploadEachFile } from '$lib/utils/upload-each';
	import type { UploadOutcome } from '$lib/utils/upload-each';
	import { formatBytes } from '$lib/utils/format';
	import { m } from '$lib/paraglide/messages';
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconFile from '@tabler/icons-svelte-runes/icons/file';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	interface Props {
		open: boolean;
		/** Route-relative SvelteKit action, e.g. `?/upload`. */
		action: string;
		/** `<input accept>` value; also used to pre-flag obviously wrong picks. */
		accept: string;
		maxBatch: number;
		maxBytes: number;
		/** One-line summary of the limits (the pages own that copy). */
		description: string;
		/** Extra line under the description, e.g. the CLI bulk-import hint. */
		hint?: Snippet;
		pickLabel?: string;
		/** Extra success note per result row (dedup / added-to-gallery), page-specific. */
		resultNote?: (result: UploadOutcome) => string | undefined;
	}

	let {
		open = $bindable(false),
		action,
		accept,
		maxBatch,
		maxBytes,
		description,
		hint,
		pickLabel = m.admin_media_pick_files(),
		resultNote
	}: Props = $props();

	/**
	 * `rejected` is a local pre-flight failure (wrong type / too big) — never sent.
	 * `error` is a server-side failure and is retried when the user hits upload again.
	 */
	type QueueStatus = 'idle' | 'uploading' | 'done' | 'error' | 'rejected';

	interface QueueItem {
		id: number;
		file: File;
		thumb?: string;
		status: QueueStatus;
		note?: string;
	}

	let queue = $state<QueueItem[]>([]);
	let nextId = 0;
	let uploading = $state(false);
	let pageDrag = $state(false);
	// dragenter/dragleave fire per child crossed; only the net count is real.
	let dragDepth = 0;

	const pending = $derived(
		queue.filter((item) => item.status === 'idle' || item.status === 'error')
	);
	const overBatch = $derived(pending.length > maxBatch);
	const canSubmit = $derived(!uploading && pending.length > 0 && !overBatch);
	const totalBytes = $derived(queue.reduce((sum, item) => sum + item.file.size, 0));

	/** Accepted extensions from the picker's `accept` (`.jpg,.png` or `image/*`). */
	const accepted = $derived(
		accept
			.split(',')
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean)
	);

	function matchesAccept(file: File): boolean {
		if (accepted.length === 0) return true;
		const name = file.name.toLowerCase();
		const type = file.type.toLowerCase();
		return accepted.some((token) => {
			if (token.startsWith('.')) return name.endsWith(token);
			if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
			return type === token;
		});
	}

	function enqueue(files: File[]): void {
		for (const file of files) {
			const id = nextId++;
			const base: QueueItem = {
				id,
				file,
				thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
				status: 'idle'
			};
			// Pre-flight only: the server is still the authority on both rules.
			if (!matchesAccept(file)) {
				queue.push({ ...base, status: 'rejected', note: m.admin_media_err_unsupported() });
			} else if (file.size > maxBytes) {
				queue.push({
					...base,
					status: 'rejected',
					note: m.admin_media_err_too_big({ name: file.name })
				});
			} else {
				queue.push(base);
			}
		}
	}

	function drop(id: number): void {
		const item = queue.find((row) => row.id === id);
		if (item?.thumb) URL.revokeObjectURL(item.thumb);
		queue = queue.filter((row) => row.id !== id);
	}

	/** Everything except what is in flight — the batch a user needs to undo is
	 *  usually a whole bad pick (wrong type / over the cap), not one chip. */
	function clearQueue(): void {
		for (const item of queue) {
			if (item.thumb && item.status !== 'uploading') URL.revokeObjectURL(item.thumb);
		}
		queue = queue.filter((item) => item.status === 'uploading');
	}

	function patch(id: number, next: Partial<QueueItem>): void {
		queue = queue.map((item) => (item.id === id ? { ...item, ...next } : item));
	}

	/** Q4 (deploy note): one request per file keeps every body under BODY_SIZE_LIMIT. */
	async function submit(): Promise<void> {
		if (!canSubmit) return;
		// Snapshot first: patching the chips to `uploading` empties `pending`.
		const batch = pending;
		const ids = batch.map((item) => item.id);
		uploading = true;
		for (const id of ids) patch(id, { status: 'uploading', note: undefined });
		try {
			const outcome = await uploadEachFile({
				action,
				files: batch.map((item) => item.file),
				maxBytes,
				fallbackMessage: m.admin_media_err_upload_failed(),
				tooLargeMessage: (name) => m.admin_media_err_too_big({ name }),
				mapError: (status, name) =>
					mapUploadError(status, name, {
						tooBig: (n) => m.admin_media_err_too_big({ name: n }),
						rate: () => m.admin_media_err_rate(),
						session: () => m.admin_media_err_session()
					}),
				onProgress: (index, phase) => {
					const id = ids[index];
					if (id === undefined) return;
					patch(id, {
						status: phase === 'done' ? 'done' : phase === 'uploading' ? 'uploading' : 'error'
					});
				}
			});
			if (outcome.redirected) {
				// Session gone: the navigation is terminal, nothing left to report.
				return;
			}
			// Match rows on file name rather than assuming a 1:1 zip — one request can
			// report several rows (photos: file row plus gallery row).
			for (const item of batch) {
				const row = outcome.results.find((result) => result.fileName === item.file.name);
				const ok = row?.ok ?? false;
				const note = ok
					? row
						? resultNote?.(row)
						: undefined
					: (row?.message ?? row?.code ?? m.admin_media_err_upload_failed());
				patch(item.id, { status: ok ? 'done' : 'error', note });
			}
			await applyUploadResults(outcome);
		} finally {
			uploading = false;
		}
	}

	// Whole-page drop: anywhere on the page (dialog closed or not) accepts files.
	onMount(() => {
		function hasFiles(event: DragEvent): boolean {
			return Array.from(event.dataTransfer?.types ?? []).includes('Files');
		}
		function onDragEnter(event: DragEvent): void {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth += 1;
			if (!open) pageDrag = true;
		}
		function onDragOver(event: DragEvent): void {
			if (!hasFiles(event)) return;
			// Without preventDefault the browser navigates away to the dropped file.
			event.preventDefault();
		}
		function onDragLeave(): void {
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) pageDrag = false;
		}
		function onDrop(event: DragEvent): void {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth = 0;
			pageDrag = false;
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			enqueue(files);
			open = true;
		}

		window.addEventListener('dragenter', onDragEnter);
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('dragleave', onDragLeave);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragenter', onDragEnter);
			window.removeEventListener('dragover', onDragOver);
			window.removeEventListener('dragleave', onDragLeave);
			window.removeEventListener('drop', onDrop);
			for (const item of queue) if (item.thumb) URL.revokeObjectURL(item.thumb);
		};
	});

	const CHIP_STATE: Record<QueueStatus, 'idle' | 'uploading' | 'done' | 'error'> = {
		idle: 'idle',
		uploading: 'uploading',
		done: 'done',
		error: 'error',
		rejected: 'error'
	};

	function sizeLabel(file: File): string {
		const size = formatBytes(file.size);
		return file.type ? `${file.type} · ${size}` : size;
	}
</script>

{#if pageDrag}
	<!-- pointer-events-none: the overlay only paints — the drop still lands on the
	     page underneath and bubbles to the window handler. -->
	<div
		class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
		role="status"
	>
		<div
			class="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background px-10 py-8"
		>
			<IconUpload class="size-8 text-primary" />
			<p class="text-sm font-medium">{m.admin_media_drop_overlay()}</p>
		</div>
	</div>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="gap-4 sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.admin_media_upload()}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>

		{#if hint}
			<div class="text-xs text-muted-foreground">
				{@render hint()}
			</div>
		{/if}

		<FileDropzone.Root
			{accept}
			multiple
			ariaLabel={pickLabel}
			onFiles={enqueue}
			disabled={uploading}
		>
			<FileDropzone.Icon><IconUpload /></FileDropzone.Icon>
			<FileDropzone.Prompt>{m.admin_media_drop_prompt()}</FileDropzone.Prompt>
			<FileDropzone.Hint>{m.admin_media_drop_hint()}</FileDropzone.Hint>
		</FileDropzone.Root>

		{#if queue.length > 0}
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between gap-2">
					<p class="text-xs text-muted-foreground">
						{m.admin_media_queue_count({ count: queue.length, size: formatBytes(totalBytes) })}
					</p>
					<Button variant="ghost" size="xs" onclick={clearQueue} disabled={uploading}>
						{m.admin_media_queue_clear()}
					</Button>
				</div>

				<Attachment.Group class="max-h-64 flex-col overflow-x-hidden overflow-y-auto">
					{#each queue as item (item.id)}
						<Attachment.Root state={CHIP_STATE[item.status]} class="w-full min-w-0 flex-nowrap">
							<Attachment.Media variant={item.thumb ? 'image' : 'icon'}>
								{#if item.thumb}
									<img src={item.thumb} alt="" />
								{:else if item.file.type.startsWith('image/')}
									<IconPhoto />
								{:else}
									<IconFile />
								{/if}
							</Attachment.Media>
							<Attachment.Content>
								<Attachment.Title>{item.file.name}</Attachment.Title>
								<Attachment.Description>
									{item.note ?? sizeLabel(item.file)}
								</Attachment.Description>
							</Attachment.Content>
							<Attachment.Actions>
								{#if item.status === 'uploading'}
									<Spinner data-icon="inline-start" class="text-muted-foreground" />
								{/if}
								<Attachment.Action
									aria-label={m.admin_media_queue_remove({ name: item.file.name })}
									title={m.admin_media_queue_remove({ name: item.file.name })}
									disabled={uploading && item.status === 'uploading'}
									onclick={() => drop(item.id)}
								>
									<IconX />
								</Attachment.Action>
							</Attachment.Actions>
						</Attachment.Root>
					{/each}
				</Attachment.Group>

				{#if overBatch}
					<p class="text-xs text-destructive">
						{m.admin_media_err_too_many({ count: maxBatch })}
					</p>
				{/if}
			</div>
		{/if}

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>
				{m.admin_common_cancel()}
			</Button>
			<Button type="button" disabled={!canSubmit} onclick={submit}>
				{#if uploading}
					<Spinner data-icon="inline-start" />
					{m.admin_media_state_uploading()}
				{:else}
					<IconUpload data-icon="inline-start" />
					{m.admin_media_upload()}
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

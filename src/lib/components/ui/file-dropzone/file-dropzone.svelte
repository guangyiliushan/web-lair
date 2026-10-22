<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const fileDropzoneVariants = tv({
		base: "group/dropzone border-input text-muted-foreground hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-ring/50 relative flex min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed bg-transparent px-4 py-6 text-center transition-colors outline-none focus-visible:ring-3 [&_svg:not([class*='size-'])]:size-8",
		variants: {
			state: {
				idle: '',
				dragging: 'border-primary bg-primary/5 text-foreground',
				disabled: 'pointer-events-none opacity-50'
			}
		},
		defaultVariants: {
			state: 'idle'
		}
	});

	export type FileDropzoneState = VariantProps<typeof fileDropzoneVariants>['state'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type DropzoneProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** Picker filter, e.g. `.jpg,.png`. Dropped files are NOT filtered — the
		 *  consumer reports rejects in its own queue so the user sees why. */
		accept?: string;
		multiple?: boolean;
		disabled?: boolean;
		/** Label for the visually hidden file input. */
		ariaLabel?: string;
		onFiles?: (files: File[]) => void;
		children?: Snippet;
	};

	let {
		ref = $bindable(null),
		class: className,
		accept,
		multiple = true,
		disabled = false,
		ariaLabel,
		onFiles,
		children,
		...restProps
	}: DropzoneProps = $props();

	let input = $state<HTMLInputElement | null>(null);
	let dragging = $state(false);
	// dragenter/dragleave fire for every child crossed; only the net count is real.
	let depth = $state(0);

	// Named `dropState`, not `state`: a local called `state` collides with the
	// `$state` rune inside the same script (svelte-check reads it as a store sub).
	const dropState = $derived(disabled ? 'disabled' : dragging ? 'dragging' : 'idle');

	function emit(files: FileList | null | undefined): void {
		const list = Array.from(files ?? []);
		if (list.length > 0) onFiles?.(list);
	}

	function openPicker(): void {
		if (disabled) return;
		input?.click();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (disabled) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openPicker();
		}
	}

	function onDragEnter(event: DragEvent): void {
		if (disabled || !event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		depth += 1;
		dragging = true;
	}

	function onDragOver(event: DragEvent): void {
		if (disabled || !event.dataTransfer?.types.includes('Files')) return;
		// Without preventDefault the browser navigates to the dropped file.
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(): void {
		depth = Math.max(0, depth - 1);
		if (depth === 0) dragging = false;
	}

	function onDrop(event: DragEvent): void {
		if (disabled) return;
		event.preventDefault();
		// Stop here so a page-level drop handler does not enqueue the same files twice.
		event.stopPropagation();
		depth = 0;
		dragging = false;
		emit(event.dataTransfer?.files);
	}

	function onPaste(event: ClipboardEvent): void {
		if (disabled) return;
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		onFiles?.(files);
	}
</script>

<div
	bind:this={ref}
	data-slot="file-dropzone"
	data-state={dropState}
	role="button"
	tabindex={disabled ? -1 : 0}
	aria-label={ariaLabel}
	aria-disabled={disabled || undefined}
	class={cn(fileDropzoneVariants({ state: dropState }), className)}
	onclick={openPicker}
	onkeydown={onKeydown}
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
	onpaste={onPaste}
	{...restProps}
>
	{@render children?.()}
	<input
		bind:this={input}
		type="file"
		class="sr-only"
		{accept}
		{multiple}
		{disabled}
		aria-hidden="true"
		tabindex="-1"
		onchange={(event) => {
			emit(event.currentTarget.files);
			// Reset so re-picking the same file still fires `change`.
			event.currentTarget.value = '';
		}}
	/>
</div>

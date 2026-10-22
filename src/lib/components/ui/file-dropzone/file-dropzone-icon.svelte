<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="file-dropzone-icon"
	class={cn(
		'flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground group-data-[state=dragging]/dropzone:bg-primary/10 group-data-[state=dragging]/dropzone:text-primary',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>

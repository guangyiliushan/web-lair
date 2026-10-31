<script lang="ts">
	import { cn } from '$lib/utils';
	import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '$lib/components/ui/empty';
	import IconInbox from '@tabler/icons-svelte-runes/icons/inbox';

	/**
	 * Compact empty placeholder for a panel column.
	 *
	 * shadcn's `Empty` is built for page-sized voids (`p-6`, `gap-4`, a media
	 * slot at `size-8`), so every dimension is scaled down here — without it a
	 * bare heading over an empty column is what the panel looked like before.
	 */
	let {
		text,
		class: className
	}: {
		text: string;
		class?: string;
	} = $props();
</script>

<Empty class={cn('w-fit justify-start gap-1 rounded-md border border-dashed p-2', className)}>
	<EmptyHeader class="gap-1">
		<EmptyMedia variant="icon" class="mb-0 size-6 rounded-md">
			<IconInbox class="size-3.5" />
		</EmptyMedia>
		<EmptyTitle class="text-[11px] text-muted-foreground">{text}</EmptyTitle>
	</EmptyHeader>
</Empty>

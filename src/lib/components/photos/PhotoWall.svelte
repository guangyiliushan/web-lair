<script lang="ts">
	import { Frame, RegularMasonryGrid } from '@masonry-grid/svelte';
	import PhotoTile from './PhotoTile.svelte';
	import type { PhotoTile as PhotoTileData } from './photo-tile';
	import type { PhotoColumns } from '$lib/photos/query';

	const GAP = 4;

	let {
		items,
		columns = 'auto',
		disabled = false,
		ariaLabel = ''
	}: {
		items: PhotoTileData[];
		columns?: PhotoColumns;
		disabled?: boolean;
		ariaLabel?: string;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let measuredWidth = $state(0);

	$effect(() => {
		const node = host;
		if (!node) return;
		const measure = () => {
			const next = node.clientWidth;
			if (Math.abs(next - measuredWidth) > 0.5) measuredWidth = next;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});

	const autoColumns = $derived(
		measuredWidth === 0
			? 4
			: measuredWidth < 640
				? 2
				: measuredWidth < 900
					? 3
					: measuredWidth < 1200
						? 4
						: 5
	);
	const columnCount = $derived(columns === 'auto' ? autoColumns : Number(columns));
	const frameWidth = $derived(
		Math.max(120, (Math.max(measuredWidth, 320) - (columnCount - 1) * GAP) / columnCount)
	);
</script>

<!-- Full-bleed gallery: 4px seams and no tile chrome. role=group only when
     named, matching the accessible-name rule used by the old grid. -->
<div
	class="photos-wall px-1 lg:px-0"
	role={ariaLabel ? 'group' : undefined}
	aria-label={ariaLabel || undefined}
	data-columns={columnCount}
>
	<div bind:this={host} class="w-full">
		<RegularMasonryGrid {frameWidth} gap={GAP} {disabled}>
			{#each items as tile (tile.id)}
				<Frame width={tile.width ?? 4} height={tile.height ?? 3} class="overflow-hidden bg-muted">
					<PhotoTile {tile} />
				</Frame>
			{/each}
		</RegularMasonryGrid>
	</div>
</div>

<style>
	.photos-wall :global(a:focus-visible) {
		outline: none;
	}
</style>

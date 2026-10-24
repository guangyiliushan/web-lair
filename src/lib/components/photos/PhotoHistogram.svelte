<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { photoTileSrc, type PhotoTile } from './photo-tile';

	let { photo }: { photo: Pick<PhotoTile, 'objectKey' | 'mimeType'> } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let brightness = $state<number | null>(null);
	let contrast = $state<number | null>(null);
	let failed = $state(false);

	const BINS = 64;
	const WIDTH = 256;
	const HEIGHT = 96;

	$effect(() => {
		const node = canvas;
		const source = photoTileSrc(photo, 'thumb');
		if (!node) return;
		let cancelled = false;
		failed = false;
		brightness = null;
		contrast = null;

		const image = new Image();
		image.decoding = 'async';
		image.onload = () => {
			if (cancelled) return;
			const context = node.getContext('2d');
			if (!context) {
				failed = true;
				return;
			}
			node.width = WIDTH;
			node.height = HEIGHT;
			context.clearRect(0, 0, WIDTH, HEIGHT);
			context.drawImage(image, 0, 0, WIDTH, HEIGHT);
			try {
				const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
				const reds = new Array<number>(BINS).fill(0);
				const greens = new Array<number>(BINS).fill(0);
				const blues = new Array<number>(BINS).fill(0);
				let lumaSum = 0;
				let lumaSquares = 0;
				const count = pixels.length / 4;
				for (let index = 0; index < pixels.length; index += 4) {
					const r = pixels[index]!;
					const g = pixels[index + 1]!;
					const b = pixels[index + 2]!;
					reds[Math.min(BINS - 1, r >> 2)]! += 1;
					greens[Math.min(BINS - 1, g >> 2)]! += 1;
					blues[Math.min(BINS - 1, b >> 2)]! += 1;
					const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
					lumaSum += luma;
					lumaSquares += luma * luma;
				}
				const mean = lumaSum / count;
				const variance = Math.max(0, lumaSquares / count - mean * mean);
				brightness = Math.round((mean / 255) * 100);
				contrast = Math.min(100, Math.round(Math.sqrt(variance) * 1.6));

				const peak = Math.max(...reds, ...greens, ...blues, 1);
				context.clearRect(0, 0, WIDTH, HEIGHT);
				context.globalCompositeOperation = 'lighter';
				const draw = (values: number[], color: string) => {
					context.fillStyle = color;
					const barWidth = WIDTH / BINS;
					for (let index = 0; index < BINS; index += 1) {
						const height = (values[index]! / peak) * HEIGHT;
						context.fillRect(index * barWidth, HEIGHT - height, barWidth, height);
					}
				};
				draw(reds, 'rgba(248, 113, 113, 0.65)');
				draw(greens, 'rgba(74, 222, 128, 0.55)');
				draw(blues, 'rgba(96, 165, 250, 0.65)');
				context.globalCompositeOperation = 'source-over';
			} catch {
				failed = true;
			}
		};
		image.onerror = () => {
			if (!cancelled) failed = true;
		};
		image.src = source;
		return () => {
			cancelled = true;
		};
	});
</script>

<section class="space-y-2">
	<div class="flex items-center justify-between gap-2">
		<h3 class="text-xs font-medium text-muted-foreground">{m.photos_histogram()}</h3>
		<div class="flex items-center gap-2 text-[10px] text-muted-foreground">
			<span class="text-red-400">R</span>
			<span class="text-green-400">G</span>
			<span class="text-blue-400">B</span>
		</div>
	</div>

	{#if failed}
		<p class="text-xs text-muted-foreground">{m.photos_histogram_unavailable()}</p>
	{:else}
		<div role="img" aria-label={m.photos_histogram_desc()}>
			<canvas bind:this={canvas} class="h-20 w-full rounded-md bg-muted/40" aria-hidden="true"
			></canvas>
		</div>
		<div class="grid grid-cols-2 gap-2 text-xs">
			<div class="rounded-md bg-muted/40 px-2 py-1.5">
				<div class="text-[10px] text-muted-foreground">{m.photos_brightness()}</div>
				<div class="font-medium tabular-nums">{brightness === null ? '—' : `${brightness}%`}</div>
			</div>
			<div class="rounded-md bg-muted/40 px-2 py-1.5">
				<div class="text-[10px] text-muted-foreground">{m.photos_contrast()}</div>
				<div class="font-medium tabular-nums">{contrast === null ? '—' : `${contrast}%`}</div>
			</div>
		</div>
	{/if}
</section>

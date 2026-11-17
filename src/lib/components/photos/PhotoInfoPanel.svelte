<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { formatDate } from '$lib/utils/i18n';
	import { formatBytes } from '$lib/utils/format';
	import {
		photoDimensions,
		photoExifParts,
		photoExposure,
		photoText,
		photoTitle,
		type PhotoDetail
	} from './photo-tile';
	import PhotoHistogram from './PhotoHistogram.svelte';

	let { photo }: { photo: PhotoDetail } = $props();

	const locale = $derived(getLocale());
	const title = $derived(photoTitle(photo, locale));
	const description = $derived(photoText(photo.description, locale));
	const dateLabel = $derived(photo.takenAt ? formatDate(new Date(photo.takenAt)) : null);
	const camera = $derived([photo.cameraMake, photo.cameraModel].filter(Boolean).join(' '));
	const aperture = $derived.by(() => {
		if (photo.fNumber === null || photo.fNumber === undefined) return null;
		const value = Number(photo.fNumber);
		return Number.isFinite(value) ? `f/${value}` : null;
	});
	const focal = $derived.by(() => {
		if (photo.focalLengthMm === null || photo.focalLengthMm === undefined) return null;
		const value = Number(photo.focalLengthMm);
		return Number.isFinite(value) ? `${value} mm` : null;
	});
	const exposure = $derived(photoExposure(photo.exposureTimeS));
	const dimensions = $derived(photoDimensions(photo));
	const coordinates = $derived(
		photo.latitude !== null && photo.longitude !== null
			? `${photo.latitude}, ${photo.longitude}`
			: null
	);
	const dominant = $derived.by(() => {
		const palette = photo.palette as { dominant?: [number, number, number] } | null;
		if (!palette?.dominant) return null;
		const [r, g, b] = palette.dominant;
		return `rgb(${r} ${g} ${b})`;
	});

	const details = $derived(
		[
			{ label: m.photos_camera(), value: camera },
			{ label: m.photos_lens(), value: photo.lensModel ?? '' },
			{ label: m.photos_aperture(), value: aperture ?? '' },
			{ label: m.photos_focal_length(), value: focal ?? '' },
			{ label: m.photos_exposure(), value: exposure ?? '' },
			{ label: m.photos_iso(), value: photo.iso === null ? '' : String(photo.iso) },
			{ label: m.photos_dimensions(), value: dimensions ?? '' },
			{ label: m.photos_file_size(), value: formatBytes(photo.byteSize) },
			{ label: m.photos_taken_at(), value: dateLabel ?? '' },
			{ label: m.photos_location(), value: coordinates ?? '' }
		].filter((row) => row.value !== '')
	);
</script>

<div class="space-y-5">
	<div class="space-y-1">
		<h2 class="text-base font-semibold tracking-tight">{title}</h2>
		{#if description}
			<p class="text-xs leading-relaxed text-muted-foreground">{description}</p>
		{/if}
		{#if dominant}
			<div class="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
				<span
					class="size-3 rounded-full border border-black/10"
					style={`background:${dominant}`}
					aria-hidden="true"
				></span>
				<span>{dominant}</span>
			</div>
		{/if}
	</div>

	<section class="space-y-2">
		<h3 class="text-xs font-medium text-muted-foreground">{m.photos_details()}</h3>
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
			{#each details as row (row.label)}
				<dt class="text-muted-foreground">{row.label}</dt>
				<dd class="min-w-0 text-right wrap-break-word">{row.value}</dd>
			{/each}
		</dl>
		{#if coordinates}
			<a
				href={siteHref('/photos/map')}
				class="inline-flex text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
			>
				{m.photos_view_map()}
			</a>
		{/if}
	</section>

	{#if photo.tags.length > 0}
		<section class="space-y-2">
			<h3 class="text-xs font-medium text-muted-foreground">{m.photos_tags()}</h3>
			<div class="flex flex-wrap gap-1.5">
				{#each photo.tags as tag (tag.id)}
					<a
						href={siteHref(`/photos?tag=${tag.id}`)}
						class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						{tag.name}
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section class="space-y-2">
		<h3 class="text-xs font-medium text-muted-foreground">{m.photos_tone()}</h3>
		<PhotoHistogram {photo} />
	</section>

	{#if photoExifParts(photo).length > 0}
		<p class="text-[10px] leading-relaxed text-muted-foreground">
			{photoExifParts(photo).join(' · ')}
		</p>
	{/if}
</div>

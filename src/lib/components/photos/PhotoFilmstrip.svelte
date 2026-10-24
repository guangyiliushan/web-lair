<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import { photoTitle, photoTileSrc, thumbhashDataUrl, type PhotoViewerSource } from './photo-tile';

	let {
		strip,
		currentId
	}: {
		strip: PhotoViewerSource[];
		currentId: string;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);
	const locale = $derived(getLocale());

	$effect(() => {
		const node = track;
		if (!node) return;
		void currentId;
		requestAnimationFrame(() => {
			node.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
				block: 'nearest',
				inline: 'center'
			});
		});
	});
</script>

<nav
	class="shrink-0 border-t border-white/10 bg-black/90 px-2 py-2"
	aria-label={m.photos_filmstrip()}
>
	<div bind:this={track} class="flex gap-1 overflow-x-auto pb-0.5">
		{#each strip as photo (photo.id)}
			{@const placeholder = thumbhashDataUrl(photo.thumbhash)}
			<a
				href={siteHref(`/photos/${photo.slug}`)}
				aria-current={photo.id === currentId ? 'page' : undefined}
				aria-label={photoTitle(photo, locale)}
				class="relative h-12 w-16 shrink-0 overflow-hidden bg-white/5 opacity-60 transition-opacity hover:opacity-100 aria-[current=page]:opacity-100 aria-[current=page]:ring-2 aria-[current=page]:ring-white"
				style={placeholder
					? `background-image:url(${placeholder});background-size:cover;background-position:center;`
					: undefined}
			>
				<img
					src={photoTileSrc(photo, 'thumb')}
					alt=""
					loading="lazy"
					decoding="async"
					class="h-full w-full object-cover"
				/>
			</a>
		{/each}
	</div>
</nav>

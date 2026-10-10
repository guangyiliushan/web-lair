<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import PhotosMap from '$lib/components/photos/photos-map.svelte';
	import { photoText } from '$lib/components/photos/photo-tile';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { siteHref } from '$lib/utils/href';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/photos/map" />

<svelte:head>
	<title>{m.photos_map_title()}</title>
</svelte:head>

<div class="mx-auto mt-14 max-w-6xl px-4 lg:mt-20 lg:px-0">
	<div class="min-w-0">
		<div class="flex items-baseline justify-between gap-4">
			<h1 id="photos-map-heading" class="text-[28px] leading-tight font-medium">
				{m.photos_map_title()}
			</h1>
			<a
				class="shrink-0 text-sm text-muted-foreground hover:text-foreground"
				href={siteHref('/photos')}
			>
				← {m.photos_back()}
			</a>
		</div>
		<p class="mt-2 text-sm text-muted-foreground">{m.photos_map_desc()}</p>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>
	</div>

	{#if data.photos.length === 0}
		<p class="py-10 text-sm text-muted-foreground">{m.photos_map_empty()}</p>
	{:else}
		<div role="region" aria-labelledby="photos-map-heading">
			<!-- A WebGL-less browser throws while the map mounts (review round
			     1): the boundary swaps in a plain link list instead of taking
			     the whole route down. -->
			<svelte:boundary>
				<PhotosMap photos={data.photos} />
				{#snippet failed()}
					<div class="rounded-lg border p-6">
						<p class="text-sm text-muted-foreground">{m.photos_map_fallback()}</p>
						<ul class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
							{#each data.photos as photo (photo.slug)}
								<li>
									<a
										class="underline hover:text-foreground"
										href={siteHref(`/photos/${photo.slug}`)}
									>
										{photoText(photo.title, getLocale()) ?? photo.slug}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/snippet}
			</svelte:boundary>
		</div>
	{/if}
</div>

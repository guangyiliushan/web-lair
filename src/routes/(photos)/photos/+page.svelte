<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import PhotoWall from '$lib/components/photos/PhotoWall.svelte';
	import PhotosCommandPalette from '$lib/components/photos/PhotosCommandPalette.svelte';
	import PhotosFilterSummary from '$lib/components/photos/PhotosFilterSummary.svelte';
	import { getPhotosUi } from '$lib/components/photos/photos-ui.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { activePhotoFilterCount } from '$lib/photos/query';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const ui = getPhotosUi();

	$effect(() => {
		ui.activeFilterCount = activePhotoFilterCount(data.query);
		ui.columns = data.query.columns;
		let cancelled = false;
		void data.feed.then((feed) => {
			if (!cancelled) ui.photoCount = feed.total;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<SeoHead path="/photos" />

<svelte:head>
	<title>{m.photos_title()}</title>
</svelte:head>

<!-- The visible page title lives in the header; this keeps the route's
     accessible name while the gallery itself starts immediately. -->
<h1 class="sr-only">{m.photos_title()}</h1>

{#await data.feed}
	<div class="grid grid-cols-2 gap-1 px-1 md:grid-cols-4" aria-hidden="true">
		{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as cell (cell)}
			<Skeleton class="aspect-4/3 w-full rounded-none" />
		{/each}
	</div>
{:then feed}
	<PhotosFilterSummary query={data.query} facets={feed.facets} total={feed.total} />

	{#if feed.items.length === 0}
		<p class="px-4 py-12 text-sm text-muted-foreground">
			{activePhotoFilterCount(data.query) > 0 ? m.photos_empty_filtered() : m.photos_empty()}
			{#if activePhotoFilterCount(data.query) > 0}
				<a
					class="ml-2 underline underline-offset-2 hover:text-foreground"
					href={siteHref('/photos')}>{m.photos_filter_clear()}</a
				>
			{/if}
		</p>
	{:else}
		<PhotoWall items={feed.items} columns={data.query.columns} ariaLabel={m.photos_title()} />
		{#if feed.moreHref}
			<div class="mt-6 mb-8 flex justify-center">
				<a
					class="rounded-full border px-5 py-2 text-sm transition-colors hover:bg-muted"
					href={`${siteHref('/photos')}${feed.moreHref}`}
				>
					{m.photos_load_more()}
				</a>
			</div>
		{/if}
	{/if}

	<PhotosCommandPalette query={data.query} facets={feed.facets} />
{/await}

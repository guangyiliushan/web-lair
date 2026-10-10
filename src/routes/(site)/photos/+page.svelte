<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import PhotosMasonry from '$lib/components/photos/photos-masonry.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Filter links always drop the cursor chain (a filter change resets it). */
	function hrefWith(patch: Record<string, string | null>): string {
		const next: Record<string, string> = {
			year: data.filters.year === null ? '' : String(data.filters.year),
			camera: data.filters.camera ?? '',
			lens: data.filters.lens ?? '',
			tag: data.filters.tag ?? ''
		};
		for (const [key, value] of Object.entries(patch)) next[key] = value ?? '';
		const query = new SvelteURLSearchParams();
		for (const [key, value] of Object.entries(next)) if (value !== '') query.set(key, value);
		const qs = query.toString();
		return qs === '' ? siteHref('/photos') : `${siteHref('/photos')}?${qs}`;
	}

	const chipClass =
		'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-muted aria-[current=page]:border-primary/60 aria-[current=page]:text-primary';
</script>

<SeoHead path="/photos" />

<div class="mx-auto mt-14 max-w-6xl px-4 lg:mt-20 lg:px-0">
	<div class="min-w-0">
		<div class="flex items-baseline justify-between gap-4">
			<h1 id="photos-heading" class="text-[28px] leading-tight font-medium">
				{m.photos_title()}
			</h1>
			<a
				class="shrink-0 text-sm text-muted-foreground hover:text-foreground"
				href={siteHref('/photos/map')}
			>
				{m.photos_map_link()}
			</a>
		</div>
		<p class="mt-2 text-sm text-muted-foreground">{m.photos_desc()}</p>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>
	</div>

	{#await data.feed}
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4" aria-hidden="true">
			{#each [0, 1, 2, 3, 4, 5, 6, 7] as cell (cell)}
				<Skeleton class="h-40 w-full" />
			{/each}
		</div>
	{:then feed}
		{@const axes = [
			{
				key: 'year',
				label: m.photos_filter_year(),
				current: data.filters.year === null ? '' : String(data.filters.year),
				values: feed.facets.years.map((value) => ({ value: String(value), label: String(value) }))
			},
			{
				key: 'camera',
				label: m.photos_filter_camera(),
				current: data.filters.camera ?? '',
				values: feed.facets.cameras.map((value) => ({ value, label: value }))
			},
			{
				key: 'lens',
				label: m.photos_filter_lens(),
				current: data.filters.lens ?? '',
				values: feed.facets.lenses.map((value) => ({ value, label: value }))
			},
			{
				key: 'tag',
				label: m.photos_filter_tag(),
				current: data.filters.tag ?? '',
				values: feed.facets.tags.map((value) => ({ value: value.id, label: value.name }))
			}
		].filter((axis) => axis.values.length > 0)}

		{#if axes.length > 0}
			<div class="mb-6 space-y-1.5" role="group" aria-label={m.photos_title()}>
				{#each axes as axis (axis.key)}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="w-12 shrink-0 text-xs text-muted-foreground">{axis.label}</span>
						<a
							href={hrefWith({ [axis.key]: null })}
							class={chipClass}
							aria-current={axis.current === '' ? 'page' : undefined}
						>
							{m.photos_filter_all()}
						</a>
						{#each axis.values as option (option.value)}
							<a
								href={hrefWith({ [axis.key]: option.value })}
								class={chipClass}
								aria-current={axis.current === option.value ? 'page' : undefined}
							>
								{option.label}
							</a>
						{/each}
					</div>
				{/each}
			</div>
		{/if}

		{#if feed.items.length === 0}
			<p class="py-10 text-sm text-muted-foreground">{m.photos_empty()}</p>
		{:else}
			<!-- No role=list: the masonry is not a flat list (a list without
			     listitem children is worse than none — review round 1). -->
			<PhotosMasonry items={feed.items} ariaLabel={m.photos_title()} />
			{#if feed.moreHref}
				<div class="mt-8 mb-4 flex justify-center">
					<a
						class="rounded-full border px-5 py-2 text-sm transition-colors hover:bg-muted"
						href={feed.moreHref}
					>
						{m.photos_load_more()}
					</a>
				</div>
			{/if}
		{/if}
	{/await}
</div>

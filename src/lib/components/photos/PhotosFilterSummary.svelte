<script lang="ts">
	import { goto } from '$app/navigation';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { IconX } from '@tabler/icons-svelte-runes';
	import {
		photoQueryParams,
		togglePhotoFilter,
		type PhotoFilterKey,
		type PhotoQuery
	} from '$lib/photos/query';
	import type { PhotoFacets } from './photo-facets';

	let {
		query,
		facets,
		total
	}: {
		query: PhotoQuery;
		facets: PhotoFacets;
		total: number;
	} = $props();

	const tagNames = $derived(new Map(facets.tags.map((tag) => [tag.id, tag.name])));

	function apply(next: PhotoQuery) {
		const params = photoQueryParams(next);
		const href = `${siteHref('/photos')}${params.toString() === '' ? '' : `?${params.toString()}`}`;
		void goto(href, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function remove(key: PhotoFilterKey, value: number | string) {
		apply(togglePhotoFilter(query, key, value));
	}

	function removeQuery() {
		apply({ ...query, q: '' });
	}

	function clearAll() {
		apply({
			...query,
			years: [],
			cameras: [],
			lenses: [],
			tagIds: [],
			tagMode: 'any',
			q: ''
		});
	}

	const chips = $derived.by(() => {
		const list: Array<{
			key: PhotoFilterKey | 'q' | 'tagMode';
			value: number | string;
			label: string;
		}> = [];
		for (const year of query.years) list.push({ key: 'years', value: year, label: String(year) });
		for (const camera of query.cameras) list.push({ key: 'cameras', value: camera, label: camera });
		for (const lens of query.lenses) list.push({ key: 'lenses', value: lens, label: lens });
		for (const tagId of query.tagIds) {
			list.push({ key: 'tagIds', value: tagId, label: tagNames.get(tagId) ?? tagId });
		}
		if (query.q !== '') list.push({ key: 'q', value: query.q, label: `“${query.q}”` });
		return list;
	});
</script>

<div class="flex flex-wrap items-center gap-2 px-3 py-3 text-sm">
	<span class="mr-1 text-xs text-muted-foreground tabular-nums">
		{m.photos_count({ count: total })}
	</span>

	{#if query.tagIds.length > 1}
		<span class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
			{query.tagMode === 'all' ? m.photos_filter_tag_all() : m.photos_filter_tag_any()}
		</span>
	{/if}

	{#each chips as chip (chip.key + String(chip.value))}
		<button
			type="button"
			onclick={() => {
				if (chip.key === 'q') removeQuery();
				else if (chip.key !== 'tagMode') remove(chip.key, chip.value);
			}}
			aria-label={m.photos_filter_remove({ label: chip.label })}
			class="inline-flex max-w-[18rem] items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		>
			<span class="truncate">{chip.label}</span>
			<IconX class="size-3 shrink-0" />
		</button>
	{/each}

	{#if chips.length > 0}
		<button
			type="button"
			onclick={clearAll}
			class="ml-1 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
		>
			{m.photos_filter_clear()}
		</button>
	{:else}
		<span class="text-xs text-muted-foreground">{m.photos_desc()}</span>
	{/if}
</div>

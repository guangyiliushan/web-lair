<script lang="ts">
	import { goto } from '$app/navigation';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconCheck from '@tabler/icons-svelte-runes/icons/check';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import * as Command from '$lib/components/ui/command';
	import { getPhotosUi } from '$lib/components/photos/photos-ui.svelte';
	import {
		activePhotoFilterCount,
		photoQueryParams,
		togglePhotoFilter,
		type PhotoFilterKey,
		type PhotoQuery
	} from '$lib/photos/query';
	import type { PhotoFacets } from './photo-facets';

	let {
		query,
		facets
	}: {
		query: PhotoQuery;
		facets: PhotoFacets;
	} = $props();

	const ui = getPhotosUi();
	let search = $state('');

	const normalized = $derived(search.trim().toLowerCase());
	const years = $derived(
		facets.years.filter((year) => normalized === '' || String(year).includes(normalized))
	);
	const cameras = $derived(
		facets.cameras.filter(
			(camera) => normalized === '' || camera.toLowerCase().includes(normalized)
		)
	);
	const lenses = $derived(
		facets.lenses.filter((lens) => normalized === '' || lens.toLowerCase().includes(normalized))
	);
	const tags = $derived(
		facets.tags.filter((tag) => normalized === '' || tag.name.toLowerCase().includes(normalized))
	);
	const filterCount = $derived(activePhotoFilterCount(query));

	function apply(next: PhotoQuery, close = false) {
		const params = photoQueryParams(next);
		const href = `${siteHref('/photos')}${params.toString() === '' ? '' : `?${params.toString()}`}`;
		void goto(href, { replaceState: true, noScroll: true, keepFocus: true });
		if (close) ui.searchOpen = false;
	}

	function toggle(key: PhotoFilterKey, value: number | string) {
		apply(togglePhotoFilter(query, key, value));
	}

	function selectTagMode(mode: 'any' | 'all') {
		apply({ ...query, tagMode: mode });
	}

	function clearFilters() {
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

	function searchAllPhotos() {
		const text = search.trim();
		if (text === '') return;
		apply({ ...query, q: text }, true);
	}
</script>

{#if ui.searchOpen}
	<Command.Dialog
		open={true}
		onOpenChange={(open) => {
			if (!open) ui.searchOpen = false;
		}}
		shouldFilter={false}
		title={m.photos_search()}
		description={m.photos_search_hint()}
		class="sm:max-w-xl"
	>
		<Command.Input placeholder={m.photos_search_placeholder()} bind:value={search} />
		<Command.List>
			<Command.Empty>{m.photos_search_empty()}</Command.Empty>

			{#if normalized !== ''}
				<Command.Group heading={m.photos_search_photos()}>
					<Command.Item value={`search-all-${normalized}`} onSelect={searchAllPhotos}>
						<IconSearch class="size-4" />
						<span class="truncate">{m.photos_search_photos()} · “{search.trim()}”</span>
					</Command.Item>
				</Command.Group>
			{/if}

			{#if years.length > 0}
				<Command.Group heading={m.photos_filter_years()}>
					{#each years as year (year)}
						<Command.Item value={`year-${year}`} onSelect={() => toggle('years', year)}>
							<IconCheck class={query.years.includes(year) ? 'size-4' : 'size-4 opacity-0'} />
							<span>{year}</span>
							{#if facets.counts?.years[String(year)]}
								<span class="ml-auto text-xs text-muted-foreground tabular-nums">
									{facets.counts.years[String(year)]}
								</span>
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}

			{#if cameras.length > 0}
				<Command.Group heading={m.photos_filter_cameras()}>
					{#each cameras as camera (camera)}
						<Command.Item value={`camera-${camera}`} onSelect={() => toggle('cameras', camera)}>
							<IconCheck class={query.cameras.includes(camera) ? 'size-4' : 'size-4 opacity-0'} />
							<span class="truncate">{camera}</span>
							{#if facets.counts?.cameras[camera]}
								<span class="ml-auto text-xs text-muted-foreground tabular-nums">
									{facets.counts.cameras[camera]}
								</span>
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}

			{#if lenses.length > 0}
				<Command.Group heading={m.photos_filter_lenses()}>
					{#each lenses as lens (lens)}
						<Command.Item value={`lens-${lens}`} onSelect={() => toggle('lenses', lens)}>
							<IconCheck class={query.lenses.includes(lens) ? 'size-4' : 'size-4 opacity-0'} />
							<span class="truncate">{lens}</span>
							{#if facets.counts?.lenses[lens]}
								<span class="ml-auto text-xs text-muted-foreground tabular-nums">
									{facets.counts.lenses[lens]}
								</span>
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}

			{#if tags.length > 0}
				<Command.Group heading={m.photos_filter_tags()}>
					{#each tags as tag (tag.id)}
						<Command.Item value={`tag-${tag.id}`} onSelect={() => toggle('tagIds', tag.id)}>
							<IconCheck class={query.tagIds.includes(tag.id) ? 'size-4' : 'size-4 opacity-0'} />
							<span class="truncate">{tag.name}</span>
							{#if tag.count}
								<span class="ml-auto text-xs text-muted-foreground tabular-nums">{tag.count}</span>
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}

			{#if query.tagIds.length > 1}
				<Command.Group heading={m.photos_filter_tag_mode()}>
					<Command.Item value="tag-mode-any" onSelect={() => selectTagMode('any')}>
						<IconCheck class={query.tagMode !== 'any' ? 'size-4 opacity-0' : 'size-4'} />
						{m.photos_filter_tag_any()}
					</Command.Item>
					<Command.Item value="tag-mode-all" onSelect={() => selectTagMode('all')}>
						<IconCheck class={query.tagMode !== 'all' ? 'size-4 opacity-0' : 'size-4'} />
						{m.photos_filter_tag_all()}
					</Command.Item>
				</Command.Group>
			{/if}

			{#if filterCount > 0}
				<Command.Separator />
				<Command.Group>
					<Command.Item value="clear-filters" onSelect={clearFilters}>
						<span class="text-muted-foreground">{m.photos_filter_clear()}</span>
					</Command.Item>
				</Command.Group>
			{/if}
		</Command.List>
	</Command.Dialog>
{/if}

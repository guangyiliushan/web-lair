<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import NoteRows from '$lib/components/notes/NoteRows.svelte';
	import NotePagination from '$lib/components/notes/NotePagination.svelte';
	import { m } from '$lib/paraglide/messages';
	import { navIcon } from '$lib/config/nav-icons';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TopicIcon = $derived(navIcon(data.topic.icon));

	function pageHref(target: number): string {
		return target > 1
			? `/notes/topics/${data.topic.slug}?page=${target}`
			: `/notes/topics/${data.topic.slug}`;
	}
</script>

<svelte:head>
	<title>{data.topic.name} - {m.nav_notes()}</title>
</svelte:head>

<SeoHead path={`/notes/topics/${data.topic.slug}`} />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<header>
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			{m.notes_topic_heading()}
		</div>
		<h1 class="flex items-center gap-2.5 text-[28px] leading-tight font-medium">
			{#if TopicIcon}
				<TopicIcon class="size-6 shrink-0 text-muted-foreground" />
			{/if}
			{data.topic.name}
		</h1>
		{#if data.topic.description}
			<p class="mt-2 text-sm text-muted-foreground">{data.topic.description}</p>
		{/if}
		<div class="mt-3 text-xs text-muted-foreground">
			{m.notes_count({ count: data.total })}
		</div>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>
	</header>

	{#if data.notes.length > 0}
		<NoteRows items={data.notes} />
	{:else}
		<p class="text-sm text-muted-foreground">{m.notes_topic_empty()}</p>
	{/if}

	<NotePagination
		page={data.page}
		totalPages={data.totalPages}
		total={data.total}
		href={pageHref}
	/>
</div>

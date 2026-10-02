<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { SeoHead } from '$lib/components/seo';
	import NoteRows from '$lib/components/notes/NoteRows.svelte';
	import NotePagination from '$lib/components/notes/NotePagination.svelte';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { IconLock } from '@tabler/icons-svelte-runes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Paginated views are self-canonical; filters consolidate on `/notes` (P3-b).
	const listPath = $derived(`/notes${data.page > 1 ? `?page=${data.page}` : ''}`);

	function filteredHref(next: {
		topic?: string | null;
		year?: number | null;
		page?: number;
	}): string {
		const topic = next.topic !== undefined ? next.topic : data.filters.topic;
		const year = next.year !== undefined ? next.year : data.filters.year;
		const query: string[] = [];
		if (topic) query.push(`topic=${encodeURIComponent(topic)}`);
		if (year !== null && year !== undefined) query.push(`year=${year}`);
		if (next.page && next.page > 1) query.push(`page=${next.page}`);
		return query.length > 0 ? `/notes?${query.join('&')}` : '/notes';
	}

	const chipBase = 'rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors';
	const chipActive = `${chipBase} bg-primary/10 text-primary`;
	const chipIdle = `${chipBase} text-muted-foreground hover:bg-muted hover:text-foreground`;
</script>

<SeoHead path={listPath} />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<div class="min-w-0">
		<div class="text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			{m.notes_kicker()}
		</div>
		<h1 class="mt-2.5 text-[28px] leading-tight font-medium">{m.notes_title()}</h1>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>

		{#if data.topics.length > 0}
			<div class="flex flex-wrap gap-1.5">
				<a href={siteHref('/notes')} class={!data.filters.topic ? chipActive : chipIdle}>
					{m.notes_filter_all()}
				</a>
				{#each data.topics as topic (topic.slug)}
					<a
						href={siteHref(filteredHref({ topic: topic.slug }))}
						class={data.filters.topic === topic.slug ? chipActive : chipIdle}
					>
						{topic.name}<span class="ml-1 text-muted-foreground/50 tabular-nums">{topic.total}</span
						>
					</a>
				{/each}
			</div>
		{/if}
		{#if data.years.length > 1}
			<div class="mt-1.5 flex flex-wrap gap-1.5">
				<a
					href={siteHref(filteredHref({ year: null }))}
					class={!data.filters.year ? chipActive : chipIdle}
				>
					{m.notes_filter_all()}
				</a>
				{#each data.years as year (year)}
					<a
						href={siteHref(filteredHref({ year }))}
						class={data.filters.year === year ? chipActive : chipIdle}
					>
						{year}
					</a>
				{/each}
			</div>
		{/if}

		{#if data.pinnedNote}
			<Card.Root
				class="mt-5 rounded-lg border bg-card/50 p-5 transition-all duration-200 hover:-translate-y-px hover:bg-card/70 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] dark:border-white/5 dark:bg-white/4 dark:hover:bg-white/6"
			>
				<a href={siteHref(`/notes/${data.pinnedNote.slug}`)} class="block">
					<Card.Header class="p-0">
						<div class="mb-2 text-xs font-medium tracking-[1px] text-primary">
							{m.notes_pinned()}
						</div>
						<Card.Title class="flex items-center gap-2 text-lg font-medium">
							{data.pinnedNote.title}
							{#if data.pinnedNote.locked}
								<IconLock
									class="size-4 shrink-0 text-muted-foreground"
									role="img"
									aria-label={m.notes_locked()}
								/>
							{/if}
						</Card.Title>
					</Card.Header>
					{#if data.pinnedNote.excerpt}
						<Card.Content class="mt-2 p-0">
							<p class="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
								{data.pinnedNote.excerpt}
							</p>
						</Card.Content>
					{/if}
					<Card.Footer class="mt-3 p-0 text-xs">
						<span class="whitespace-nowrap text-muted-foreground">{data.pinnedNote.date}</span>
					</Card.Footer>
				</a>
			</Card.Root>
		{/if}

		<div class="mt-5 flex items-center justify-between border-b border-border/50 pb-3">
			<span class="text-xs text-muted-foreground">{m.notes_count({ count: data.total })}</span>
		</div>

		{#if data.notes.length > 0}
			<NoteRows items={data.notes} />
		{:else if !data.pinnedNote}
			<p class="mt-10 text-sm text-muted-foreground">{m.notes_empty()}</p>
		{/if}

		<NotePagination
			page={data.page}
			totalPages={data.totalPages}
			total={data.total}
			href={(target) => filteredHref({ page: target })}
		/>
	</div>
</div>

<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { m } from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/projects" />

<div class="mx-auto mt-14 max-w-5xl px-4 lg:mt-20 lg:px-0">
	<div class="min-w-0">
		<h1 id="projects-heading" class="text-[28px] leading-tight font-medium">
			{m.projects_title()}
		</h1>
		<p class="mt-2 text-sm text-muted-foreground">{m.projects_desc()}</p>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>
	</div>

	{#await data.rows}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
			{#each [0, 1, 2, 3, 4, 5] as i (i)}
				<Skeleton class="h-32 w-full" />
			{/each}
		</div>
	{:then rows}
		{#if rows.length === 0}
			<p class="py-6 text-sm text-muted-foreground">{m.projects_empty()}</p>
		{:else}
			<div
				class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
				role="list"
				aria-labelledby="projects-heading"
			>
				{#each rows as row (row.id)}
					<ProjectCard project={row} />
				{/each}
			</div>
		{/if}
	{/await}
</div>

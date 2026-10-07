<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<SeoHead path="/thoughts" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<div class="min-w-0">
		<h1 class="text-[28px] leading-tight font-medium">{m.thoughts_title()}</h1>
		<p class="mt-2 text-sm text-muted-foreground">{m.nav_more_thoughts_desc()}</p>
		<div class="mt-6 mb-2 h-px w-8 bg-primary/70"></div>
	</div>

	{#await data.rows}
		<div class="flex flex-col gap-4 py-6" aria-hidden="true">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton class="h-20 w-full" />
			{/each}
		</div>
	{:then rows}
		{#if rows.length === 0}
			<p class="py-6 text-sm text-muted-foreground">{m.thoughts_empty()}</p>
		{:else}
			<div class="divide-y divide-border/60">
				{#each rows as row (row.id)}
					<article class="group py-6">
						<a href={siteHref(`/thoughts/${row.id}`)} class="block">
							<div class="flex items-start gap-3">
								<IconBulb class="mt-1 size-4 shrink-0 text-muted-foreground/60" />
								<div class="min-w-0 flex-1">
									<p class="text-base leading-7 wrap-break-word whitespace-pre-wrap">
										{row.content}
									</p>
									<time class="mt-2 block text-xs text-muted-foreground">{row.dateLabel}</time>
								</div>
							</div>
						</a>
					</article>
				{/each}
			</div>
		{/if}
	{/await}
</div>

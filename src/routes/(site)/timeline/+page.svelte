<script lang="ts">
	import { SeoHead } from '$lib/components/seo';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const filters = [
		{ key: 'all', label: m.timeline_filter_all(), href: '/timeline' },
		{ key: 'post', label: m.nav_timeline_posts(), href: '/timeline?type=post' },
		{ key: 'note', label: m.nav_timeline_notes(), href: '/timeline?type=note' }
	] as const;
</script>

<!-- Filtered views consolidate on the unfiltered canonical (P3-b). -->
<SeoHead path="/timeline" />

<div class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0 2xl:max-w-4xl">
	<header>
		<div class="mb-4 text-[10px] font-medium tracking-[4px] text-muted-foreground uppercase">
			{m.timeline_stream()}
		</div>
		<h1 class="text-[28px] leading-tight font-medium">{m.nav_timeline()}</h1>
		<div class="mt-6 mb-6 h-px w-8 bg-primary/70"></div>

		<div class="mb-7 flex gap-1.5">
			{#each filters as filter (filter.key)}
				<a
					href={siteHref(filter.href)}
					class={[
						'rounded-full px-3 py-1 text-xs transition-colors',
						data.type === filter.key
							? 'bg-primary/10 text-primary'
							: 'text-muted-foreground hover:bg-muted hover:text-foreground'
					]}
				>
					{filter.label}
				</a>
			{/each}
		</div>
	</header>

	{#if data.items.length > 0}
		<ul class="min-w-0">
			{#each data.items as item (item.kind + item.slug)}
				<li class="list-none">
					<a
						href={siteHref(item.kind === 'note' ? `/notes/${item.slug}` : `/posts/${item.slug}`)}
						class="group -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-b border-foreground/5 px-3 py-3.5 transition-[background] duration-300 ease-out hover:bg-linear-to-r hover:from-transparent hover:via-primary/6 hover:to-transparent"
					>
						<span
							class="flex min-w-0 items-center gap-1.5 text-sm font-normal text-foreground/85 transition-colors duration-200 group-hover:text-primary group-focus-visible:text-primary"
						>
							<span class="min-w-0 truncate">{item.title}</span>
							{#if item.locked}
								<IconLock
									class="size-3.5 shrink-0 text-muted-foreground/60"
									role="img"
									aria-label={m.notes_locked()}
								/>
							{/if}
						</span>
						<span class="shrink-0 text-xs whitespace-nowrap text-muted-foreground/40 tabular-nums">
							{item.date}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">{m.timeline_empty()}</p>
	{/if}
</div>

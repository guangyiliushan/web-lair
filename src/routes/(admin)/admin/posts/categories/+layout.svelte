<script lang="ts">
	import type { LayoutData } from './$types';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	/** Selection lives in the route, so back/forward and deep links just work. */
	const selectedId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>{m.admin_categories_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={selectedId !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.nav_posts_categories()}</h2>
			<span class="ml-auto text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: data.categories.length })}
			</span>
		</ListDetail.Toolbar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if data.categories.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_categories_empty()}</p>
				</Empty>
			{:else}
				{#each data.categories as cat (cat.id)}
					<ListDetail.Row href="/admin/posts/categories/{cat.id}" selected={selectedId === cat.id}>
						<IconFolder class="size-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-medium">{cat.name}</h3>
							<p
								class="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
							>
								<IconHash class="size-3 shrink-0" />
								{cat.slug}
							</p>
						</div>
						<span class="text-xs text-muted-foreground tabular-nums">
							{data.postCounts[cat.id] ?? 0}
						</span>
					</ListDetail.Row>
				{/each}
			{/if}
		</div>
	</ListDetail.List>

	<ListDetail.Detail id={selectedId}>
		{@render children()}
	</ListDetail.Detail>
</ListDetail.Root>

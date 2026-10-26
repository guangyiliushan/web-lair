<script lang="ts">
	import type { LayoutData } from './$types';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { Empty } from '$lib/components/ui/empty';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import * as ListDetail from '$lib/components/admin/list-detail';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import IconCrown from '@tabler/icons-svelte-runes/icons/crown';
	import IconBan from '@tabler/icons-svelte-runes/icons/ban';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let roleFilter = $state('all');
	let query = $state('');

	/** Selection lives in the route, so back/forward and deep links just work. */
	const selectedId = $derived(page.params.id ?? null);

	const visible = $derived(
		data.readers.filter((r) => {
			const matchRole =
				roleFilter === 'all' ||
				(roleFilter === 'banned' ? r.banned : !r.banned && r.role === roleFilter);
			if (!matchRole) return false;
			const q = query.trim().toLowerCase();
			if (q === '') return true;
			return r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
		})
	);

	const filterCounts = $derived({
		all: data.counts.all,
		owner: data.counts.owner,
		reader: data.counts.reader,
		banned: data.counts.banned
	});
</script>

<svelte:head>
	<title>{m.admin_readers_title()} - Lair Admin</title>
</svelte:head>

<ListDetail.Root detailOpen={selectedId !== null}>
	<ListDetail.List>
		<ListDetail.Toolbar>
			<h2 class="truncate text-sm font-semibold">{m.admin_readers()}</h2>
			<!-- sr-only Label, not aria-label: a real <label for> association (click
			     focuses the field, SRs read the name). Zero layout impact. -->
			<Label class="sr-only" for="readers-search">{m.admin_readers_search()}</Label>
			<Input
				id="readers-search"
				type="search"
				class="h-8 min-w-0 flex-1 border-transparent bg-transparent"
				placeholder={m.admin_readers_search()}
				bind:value={query}
			/>
			<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
				{m.admin_master_detail_count({ count: visible.length })}
			</span>
		</ListDetail.Toolbar>

		<div class="flex h-10 shrink-0 items-center gap-2 border-b px-4">
			<ToggleGroup.Root
				type="single"
				bind:value={roleFilter}
				variant="outline"
				size="sm"
				class="gap-1"
			>
				<ToggleGroup.Item value="all">
					{m.admin_readers_role_all()}
					{filterCounts.all}
				</ToggleGroup.Item>
				<ToggleGroup.Item value="owner">
					{m.admin_readers_role_owner()}
					{filterCounts.owner}
				</ToggleGroup.Item>
				<ToggleGroup.Item value="reader">
					{m.admin_readers_role_reader()}
					{filterCounts.reader}
				</ToggleGroup.Item>
				<ToggleGroup.Item value="banned">
					{m.admin_readers_ban()}
					{filterCounts.banned}
				</ToggleGroup.Item>
			</ToggleGroup.Root>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if visible.length === 0}
				<Empty class="py-8">
					<p class="text-sm text-muted-foreground">{m.admin_readers_empty()}</p>
				</Empty>
			{:else}
				{#each visible as reader (reader.id)}
					<ListDetail.Row href="/admin/readers/{reader.id}" selected={selectedId === reader.id}>
						<span
							class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted"
						>
							{#if reader.avatar}
								<img alt="" class="size-8 object-cover" src={reader.avatar} />
							{:else}
								<span class="text-xs font-medium text-muted-foreground">
									{reader.name.slice(0, 1).toUpperCase()}
								</span>
							{/if}
						</span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<h3 class="truncate text-sm font-medium">{reader.name}</h3>
								{#if reader.role === 'owner'}
									<IconCrown class="size-3 shrink-0 text-amber-500" />
								{/if}
								{#if reader.banned}
									<IconBan class="size-3 shrink-0 text-destructive" />
								{/if}
							</div>
							<p class="mt-0.5 truncate text-xs text-muted-foreground">{reader.email}</p>
						</div>
						<Badge variant="outline" class="shrink-0 text-[10px]">
							{reader.role === 'owner'
								? m.admin_readers_role_owner()
								: m.admin_readers_role_reader()}
						</Badge>
					</ListDetail.Row>
				{/each}
			{/if}
		</div>
	</ListDetail.List>

	<ListDetail.Detail id={selectedId}>
		{@render children()}
	</ListDetail.Detail>
</ListDetail.Root>

<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		total: number;
		page: number;
		pageSize: number;
		/** Build the href for a 1-based page, preserving the active filters. */
		pageHref: (page: number) => string;
	}

	let { total, page, pageSize, pageHref }: Props = $props();

	const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
	const from = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
	const to = $derived(Math.min(total, page * pageSize));
</script>

<div
	class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-3 py-2.5 text-xs text-muted-foreground"
>
	<span class="tabular-nums">
		{m.admin_common_count_entries({ count: total })}
		{#if total > 0}{m.admin_posts_showing_range({ from, to })}{/if}
	</span>
	{#if totalPages > 1}
		<nav class="flex items-center gap-1.5" aria-label={m.admin_list_pagination()}>
			<Button variant="outline" size="xs" href={pageHref(page - 1)} disabled={page <= 1}>
				{m.admin_common_prev()}
			</Button>
			<span class="px-1 tabular-nums">{page} / {totalPages}</span>
			<Button variant="outline" size="xs" href={pageHref(page + 1)} disabled={page >= totalPages}>
				{m.admin_common_next()}
			</Button>
		</nav>
	{/if}
</div>

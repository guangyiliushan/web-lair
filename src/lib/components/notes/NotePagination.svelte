<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Pagination from '$lib/components/ui/pagination';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { IconArrowLeft, IconArrowRight } from '@tabler/icons-svelte-runes';

	let {
		page,
		totalPages,
		total,
		perPage,
		href
	}: {
		page: number;
		totalPages: number;
		total: number;
		/** Items per page (NOTE_PAGE_SIZE from the UI-safe notes module). */
		perPage: number;
		/** Builds the link for a target page (filters preserved by the caller). */
		href: (target: number) => string;
	} = $props();

	const buttonClass =
		'inline-flex items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary';
	const disabledClass =
		'inline-flex cursor-default items-center gap-1.5 text-xs font-medium tracking-[2.5px] text-muted-foreground/60 uppercase';
</script>

{#if totalPages > 1}
	<nav class="mt-20 border-t border-border/40 pt-5" aria-label="Pagination">
		<Pagination.Root count={total} {perPage} {page}>
			<Pagination.Content class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
				<Pagination.Item class="list-none">
					{#if page > 1}
						<Button variant="ghost" href={siteHref(href(page - 1))} class={buttonClass}>
							<IconArrowLeft data-icon="inline-start" class="shrink-0" />
							<span>{m.pagination_previous()}</span>
						</Button>
					{:else}
						<Button variant="ghost" disabled class={disabledClass}>
							<IconArrowLeft data-icon="inline-start" class="shrink-0" />
							<span>{m.pagination_previous()}</span>
						</Button>
					{/if}
				</Pagination.Item>

				<Pagination.Item class="list-none text-center">
					<span aria-hidden="true" class="text-muted-foreground/40">·</span>
				</Pagination.Item>

				<Pagination.Item class="list-none justify-self-end">
					{#if page < totalPages}
						<Button variant="ghost" href={siteHref(href(page + 1))} class={buttonClass}>
							<span>{m.pagination_next()}</span>
							<IconArrowRight data-icon="inline-end" class="shrink-0" />
						</Button>
					{:else}
						<Button variant="ghost" disabled class={disabledClass}>
							<span>{m.pagination_next()}</span>
							<IconArrowRight data-icon="inline-end" class="shrink-0" />
						</Button>
					{/if}
				</Pagination.Item>

				<div
					class="col-span-full mt-2 text-center text-xs tracking-[3px] text-muted-foreground uppercase tabular-nums"
				>
					{m.pagination_page({ page: String(page), total: String(totalPages) })}
				</div>
			</Pagination.Content>
		</Pagination.Root>
	</nav>
{/if}

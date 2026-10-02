<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';

	export interface NoteRowItem {
		slug: string;
		title: string;
		date: string;
		excerpt: string | null;
		image: string | null;
		locked: boolean;
	}

	let { items }: { items: NoteRowItem[] } = $props();
</script>

<ul class="min-w-0">
	{#each items as item (item.slug)}
		<li class="list-none">
			<a
				href={siteHref(`/notes/${item.slug}`)}
				class="group -mx-3 flex items-start gap-3 border-b border-foreground/5 px-3 py-3.5 transition-[background] duration-300 ease-out hover:bg-linear-to-r hover:from-transparent hover:via-primary/6 hover:to-transparent"
			>
				{#if item.image}
					<img
						src={item.image}
						alt=""
						loading="lazy"
						class="mt-0.5 size-10 shrink-0 rounded object-cover"
					/>
				{/if}
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-1.5">
						<span
							class="min-w-0 truncate text-sm font-normal text-foreground/85 transition-colors duration-200 group-hover:text-primary group-focus-visible:text-primary"
						>
							{item.title}
						</span>
						{#if item.locked}
							<IconLock
								class="size-3.5 shrink-0 text-muted-foreground/60"
								role="img"
								aria-label={m.notes_locked()}
							/>
						{/if}
					</span>
					{#if item.excerpt}
						<span class="mt-1 line-clamp-1 text-xs leading-normal text-muted-foreground">
							{item.excerpt}
						</span>
					{/if}
				</span>
				<span class="shrink-0 text-xs whitespace-nowrap text-muted-foreground/40 tabular-nums">
					{item.date}
				</span>
			</a>
		</li>
	{/each}
</ul>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	interface Props {
		/** Route this search belongs to, e.g. `/admin/posts`. */
		path: Pathname;
		/** Applied keyword from the URL. */
		value?: string;
		placeholder?: string;
		/** Screen-reader name for the field. */
		label: string;
		/** Active filters to preserve on submit (name → value). */
		hidden?: Record<string, string>;
		/** Query string with the keyword dropped, used by the clear control. */
		clearSearch?: string;
	}

	let {
		path,
		value = '',
		placeholder = '',
		label,
		hidden = {},
		clearSearch = ''
	}: Props = $props();
</script>

<form method="GET" action={resolve(path)} role="search" class="w-full min-w-0">
	{#each Object.entries(hidden) as [name, field] (name)}
		<input type="hidden" {name} value={field} />
	{/each}
	<div class="relative flex h-7 w-full min-w-0 items-center">
		<IconSearch
			class="pointer-events-none absolute top-1/2 left-1 size-3.5 -translate-y-1/2 text-muted-foreground"
		/>
		<input
			type="search"
			name="keyword"
			{placeholder}
			aria-label={label}
			{value}
			class="h-7 w-full min-w-0 border-0 bg-transparent pr-7 pl-6 text-xs outline-none placeholder:text-muted-foreground focus:ring-0"
		/>
		{#if value}
			<a
				href="{resolve(path)}{clearSearch}"
				aria-label={m.admin_list_search_clear()}
				title={m.admin_list_search_clear()}
				class="absolute top-1/2 right-0.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				<IconX class="size-3" />
			</a>
		{/if}
	</div>
</form>

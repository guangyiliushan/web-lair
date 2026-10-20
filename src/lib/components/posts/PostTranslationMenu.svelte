<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref, locales } from '$lib/paraglide/runtime';
	import { localeLabels } from '$lib/stores/locale.svelte';
	import { IconCheck, IconChevronDown, IconLanguage } from '@tabler/icons-svelte-runes';

	/**
	 * Per-post language switcher: the header switcher only changes the site
	 * locale, and translation siblings can live on different slugs, so every
	 * entry links to its own path. The group's source row carries the
	 * "Original" badge; the page being read carries the check.
	 */

	interface Translation {
		/** Locale tag of this sibling. */
		lang: string;
		/** Neutral path of this sibling (no locale prefix). */
		path: string;
		/** True for the row the rest of the group was translated from. */
		isSource: boolean;
	}

	interface Props {
		translations: Translation[];
		/** Locale tag of the page being read. */
		current: string;
	}

	let { translations, current }: Props = $props();

	const label = (lang: string): string => localeLabels[lang] ?? lang;

	const href = (path: string, lang: string): string =>
		localizeHref(path, { locale: lang as (typeof locales)[number] });
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				data-testid="post-translation-trigger"
				aria-label={m.post_translation_switch()}
				class="flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground"
			>
				<IconLanguage class="size-3.5" />
				<span>{label(current)}</span>
				<IconChevronDown class="size-3 opacity-60" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" sideOffset={6} class="min-w-44">
		{#each translations as item (item.lang)}
			<DropdownMenu.Item
				data-testid="post-translation-option"
				data-lang={item.lang}
				data-current={item.lang === current}
				class={item.lang === current ? 'bg-accent/60' : undefined}
			>
				<a href={href(item.path, item.lang)} class="flex w-full items-center justify-between gap-2">
					<span class="flex items-center gap-2">
						{label(item.lang)}
						{#if item.isSource}
							<span
								data-testid="post-translation-source"
								class="rounded bg-muted px-1 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase"
							>
								{m.post_translation_source()}
							</span>
						{/if}
					</span>
					{#if item.lang === current}
						<IconCheck class="size-3.5 text-primary-text" />
					{/if}
				</a>
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>

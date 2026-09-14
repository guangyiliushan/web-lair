<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { localeStore, localeLabels } from '$lib/stores/locale.svelte';
	import { getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { IconLanguage } from '@tabler/icons-svelte-runes';

	const locales = $derived(
		localeStore.available.map((tag) => ({
			value: tag,
			label: localeLabels[tag] ?? tag
		}))
	);

	function switchLocale(v: string) {
		localeStore.switchTo(v);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{@const merged = { ...props, class: 'size-9 rounded-full' }}
			<Button variant="ghost" size="icon" aria-label={m.ui_language()} {...merged}>
				<IconLanguage data-icon="inline-start" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" sideOffset={8}>
		<DropdownMenu.Label>{m.ui_language()}</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.RadioGroup value={getLocale()} onValueChange={switchLocale}>
			{#each locales as { value, label } (value)}
				<DropdownMenu.RadioItem {value}>
					{label}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>

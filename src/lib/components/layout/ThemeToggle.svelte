<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { mergeProps } from 'bits-ui';
	import { m } from '$lib/paraglide/messages';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { IconSunHigh, IconMoonStars, IconDeviceDesktop } from '@tabler/icons-svelte-runes';

	const themes = [
		{ value: 'light' as const, label: m.ui_theme_light, icon: IconSunHigh },
		{ value: 'dark' as const, label: m.ui_theme_dark, icon: IconMoonStars },
		{ value: 'system' as const, label: m.ui_theme_system, icon: IconDeviceDesktop }
	] as const;

	let current = $derived(themeStore.value);

	function setTheme(v: string) {
		if (v === 'light' || v === 'dark' || v === 'system') {
			themeStore.value = v;
		}
	}
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props: tooltipProps })}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props: dropdownProps })}
						{@const merged = mergeProps(tooltipProps, dropdownProps, {
							class: 'size-9 rounded-full'
						})}
						<Button variant="ghost" size="icon" aria-label={m.ui_toggle_theme()} {...merged}>
							<IconSunHigh
								data-icon="inline-start"
								class="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90"
							/>
							<IconMoonStars
								data-icon="inline-start"
								class="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0"
							/>
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" sideOffset={8}>
					<DropdownMenu.Label>{m.ui_toggle_theme()}</DropdownMenu.Label>
					<DropdownMenu.Separator />
					<DropdownMenu.RadioGroup value={current} onValueChange={setTheme}>
						{#each themes as { value, label, icon } (value)}
							{@const Icon = icon}
							<DropdownMenu.RadioItem {value}>
								<Icon />
								{label()}
							</DropdownMenu.RadioItem>
						{/each}
					</DropdownMenu.RadioGroup>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{m.ui_toggle_theme()}
	</Tooltip.Content>
</Tooltip.Root>

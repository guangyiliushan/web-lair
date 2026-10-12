<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>{m.admin_settings_site_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">
					{m.admin_settings_site_section_urls()}
				</h2>
			</div>
		</header>
		<div class="space-y-5">
			{#each [[m.admin_settings_site_field_frontend_url(), 'frontendUrl'], [m.admin_settings_site_field_admin_url(), 'adminUrl'], [m.admin_settings_site_field_api_url(), 'apiUrl'], [m.admin_settings_site_field_gateway_url(), 'gatewayUrl']] as [label, key] (key)}
				<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
					<div class="md:pt-1.5"><div class="text-sm">{label}</div></div>
					<div class="min-w-0">
						<Input type="text" value={s.site[key as keyof typeof s.site] as string} />
					</div>
				</div>
			{/each}
		</div>
	</section>
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">
					{m.admin_settings_site_section_seo()}
				</h2>
			</div>
		</header>
		<div class="space-y-5">
			{#each [[m.admin_settings_site_field_title(), 'title'], [m.admin_settings_site_field_description(), 'description'], [m.admin_settings_site_field_light_icon(), 'lightIcon'], [m.admin_settings_site_field_dark_icon(), 'darkIcon']] as [label, key] (key)}
				<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
					<div class="md:pt-1.5"><div class="text-sm">{label}</div></div>
					<div class="min-w-0">
						<Input type="text" value={s.site[key as keyof typeof s.site] as string} />
					</div>
				</div>
			{/each}
			<div class="grid items-start gap-x-8 gap-y-2 md:grid-cols-2">
				<div class="md:pt-1.5">
					<div class="text-sm">{m.admin_settings_site_field_keywords()}</div>
				</div>
				<div class="min-w-0">
					<div class="space-y-2">
						<div class="flex flex-wrap gap-2">
							{#each s.site.keywords as kw (kw)}
								<Badge variant="secondary" class="gap-1">
									{kw}
									<button
										type="button"
										class="inline-flex size-3 items-center"
										aria-label={m.admin_settings_remove_keyword({ keyword: kw })}
										><IconX class="size-3" /></button
									>
								</Badge>
							{/each}
						</div>
						<Input type="text" placeholder={m.admin_settings_keywords_placeholder()} />
					</div>
				</div>
			</div>
		</div>
	</section>
	<div class="flex justify-end">
		<Button type="button" size="sm">
			<IconDeviceFloppy data-icon="inline-start" />
			{m.admin_common_save()}
		</Button>
	</div>
</div>

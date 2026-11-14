<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { SettingsStatusList, SettingsStatusRow } from '$lib/components/admin/settings';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.admin_settings_integrations_section()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
	</div>

	<SettingsStatusList
		title={m.admin_settings_integrations_section()}
		description={m.admin_settings_integrations_status_hint()}
	>
		<SettingsStatusRow
			label={m.admin_settings_integrations_github()}
			badge={data.githubConfigured
				? m.admin_settings_common_configured()
				: m.admin_settings_common_not_configured()}
		/>
		<SettingsStatusRow label="TMDB" badge={m.admin_settings_integrations_planned()} />
		<SettingsStatusRow label="Bangumi" badge={m.admin_settings_integrations_planned()} />
		<SettingsStatusRow label="NeoDB" badge={m.admin_settings_integrations_planned()} />
		<SettingsStatusRow label="arXiv" badge={m.admin_settings_integrations_static()} />
		<SettingsStatusRow label="LeetCode" badge={m.admin_settings_integrations_static()} />
		<SettingsStatusRow label="Music" badge={m.admin_settings_integrations_static()} />
	</SettingsStatusList>
</div>

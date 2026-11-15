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

	<!-- GitHub rich cards: the only provider with a real consumer (GITHUB_TOKEN). -->
	<SettingsStatusList
		title={m.admin_settings_integrations_rich_group()}
		description={m.admin_settings_integrations_rich_hint()}
	>
		<SettingsStatusRow
			label={m.admin_settings_integrations_github()}
			hint={m.admin_settings_integrations_github_hint()}
			badge={data.githubConfigured
				? m.admin_settings_common_configured()
				: m.admin_settings_common_not_configured()}
		/>
	</SettingsStatusList>

	<!-- Future rich cards: no key consumer exists, so no field is rendered. -->
	<SettingsStatusList
		title={m.admin_settings_integrations_planned_group()}
		description={m.admin_settings_integrations_planned_hint()}
	>
		<SettingsStatusRow label="TMDB" badge={m.admin_settings_integrations_planned()} />
		<SettingsStatusRow label="Bangumi" badge={m.admin_settings_integrations_planned()} />
		<SettingsStatusRow label="NeoDB" badge={m.admin_settings_integrations_planned()} />
	</SettingsStatusList>

	<!-- Static embeds: rendered from the public URL, nothing to configure. -->
	<SettingsStatusList
		title={m.admin_settings_integrations_static_group()}
		description={m.admin_settings_integrations_static_hint()}
	>
		<SettingsStatusRow label="arXiv" badge={m.admin_settings_integrations_static()} />
		<SettingsStatusRow label="LeetCode" badge={m.admin_settings_integrations_static()} />
		<SettingsStatusRow label="NetEase" badge={m.admin_settings_integrations_static()} />
		<SettingsStatusRow label="QQ" badge={m.admin_settings_integrations_static()} />
	</SettingsStatusList>
</div>

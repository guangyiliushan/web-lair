<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import {
		SettingsStatusList,
		SettingsStatusRow,
		SettingsProviderStatus
	} from '$lib/components/admin/settings';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.admin_settings_site_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
	</div>

	<SettingsStatusList title={m.admin_settings_site_identity()}>
		<SettingsStatusRow label={m.admin_settings_site_field_title()} value={data.info.name} />
		<SettingsStatusRow
			label={m.admin_settings_site_field_description()}
			value={data.info.description}
		/>
		<SettingsStatusRow label={m.admin_settings_user_avatar()} value={data.info.avatar} />
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_site_languages()}>
		<SettingsStatusRow
			label={m.admin_settings_site_languages()}
			value={data.languages.enabled.join(', ')}
		/>
		<SettingsStatusRow label={m.admin_settings_site_default_lang()} value={data.defaultLang} />
		<SettingsStatusRow label={m.admin_settings_site_timezone()} value={data.timezone} />
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_site_deployment()}>
		<SettingsStatusRow
			label={m.admin_settings_site_origin()}
			value={data.deployment.origin ?? '—'}
		/>
		<SettingsStatusRow
			label={m.admin_settings_site_admin_path()}
			value={data.deployment.adminPath}
		/>
		<SettingsStatusRow
			label={m.admin_settings_site_environment()}
			value={data.deployment.environment}
		/>
		<SettingsStatusRow label={m.admin_settings_site_version()} value={data.deployment.version} />
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_site_search_indexing()}>
		<SettingsStatusRow
			label={m.admin_settings_site_sitemap()}
			value={m.admin_settings_common_configured()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_site_robots()}
			value={m.admin_settings_common_configured()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_site_site_search()}
			badge={m.admin_settings_site_not_implemented()}
		/>
	</SettingsStatusList>

	<div class="divide-y rounded-lg border">
		<SettingsProviderStatus name="IndexNow" state="planned" />
		<SettingsProviderStatus name="Baidu" state="planned" />
		<SettingsProviderStatus name="Bing" state="planned" />
	</div>
</div>

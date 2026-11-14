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
	<title>{m.admin_settings_storage_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
	</div>

	<SettingsStatusList title={m.admin_settings_storage_current()}>
		<SettingsStatusRow
			label={m.admin_settings_storage_bucket()}
			value={data.bucket ?? m.admin_settings_common_not_configured()}
		/>
	</SettingsStatusList>

	<div class="divide-y rounded-lg border">
		<SettingsProviderStatus
			name={m.admin_settings_storage_local()}
			state="configured"
			detail={m.admin_settings_storage_local_hint()}
		/>
		<SettingsProviderStatus
			name={m.admin_settings_storage_external()}
			state="planned"
			detail={m.admin_settings_storage_external_planned_hint()}
		/>
	</div>

	<SettingsStatusList
		title={m.admin_settings_storage_media_purge()}
		description={m.admin_settings_storage_purge_hint()}
	>
		<SettingsStatusRow
			label={m.admin_settings_storage_pending_ttl_days()}
			value={String(data.purge.pendingDays)}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_detached_ttl()}
			value={String(data.purge.detachedDays)}
		/>
	</SettingsStatusList>
</div>

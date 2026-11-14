<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { SettingsStatusList, SettingsStatusRow } from '$lib/components/admin/settings';

	let { data }: PageProps = $props();

	const profile = $derived(data.view.profile);
	const links = $derived(profile?.links ?? []);
</script>

<svelte:head>
	<title>{m.admin_settings_user_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
		{#if !data.editable}
			<span class="text-xs text-muted-foreground">{m.admin_settings_common_owner_only()}</span>
		{/if}
	</div>

	<SettingsStatusList
		title={m.admin_settings_user_title()}
		description={m.admin_settings_user_intro()}
	>
		<SettingsStatusRow
			label={m.admin_settings_profile_full_name()}
			value={profile?.displayName ?? m.admin_settings_common_not_configured()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_profile_header_label()}
			value={profile?.headerLabel ?? m.admin_settings_profile_full_name()}
			hint={m.admin_settings_profile_header_label_hint()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_user_avatar()}
			value={profile?.avatarUrl ?? m.admin_settings_common_not_configured()}
			hint={m.admin_settings_profile_avatar_hint()}
		/>
		<SettingsStatusRow label={m.admin_settings_user_social()} value={String(links.length)} />
		<SettingsStatusRow
			label={m.admin_settings_user_email()}
			value={data.view.email ?? m.admin_settings_common_not_configured()}
		/>
	</SettingsStatusList>
</div>

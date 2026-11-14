<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { SettingsStatusList, SettingsStatusRow } from '$lib/components/admin/settings';

	let { data }: PageProps = $props();

	const onOff = (value: boolean) =>
		value ? m.admin_settings_common_on() : m.admin_settings_common_off();
</script>

<svelte:head>
	<title>{m.admin_settings_content_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
	</div>

	<SettingsStatusList
		title={m.admin_settings_content_comments_section()}
		description={m.admin_settings_content_comments_desc()}
	>
		<SettingsStatusRow
			label={m.admin_settings_content_moderation()}
			value={onOff(data.moderation)}
		/>
		<SettingsStatusRow
			label={m.admin_settings_content_privacy()}
			badge={m.admin_settings_integrations_planned()}
		/>
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_content_friends_section()}>
		<SettingsStatusRow
			label={m.admin_settings_content_friends_apply()}
			value={onOff(data.friendsApply.enabled)}
		/>
		<SettingsStatusRow
			label={m.admin_settings_content_friend_subpaths()}
			value={onOff(data.friendsApply.allowSubPath)}
		/>
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_content_presence()}>
		<SettingsStatusRow
			label={m.admin_settings_content_presence()}
			value={onOff(data.presence.enabled)}
		/>
		<SettingsStatusRow
			label={m.admin_settings_content_reader_view()}
			value={onOff(data.presence.readerView)}
		/>
		<SettingsStatusRow
			label={m.admin_settings_content_reader_dots()}
			value={onOff(data.presence.readerDots)}
		/>
	</SettingsStatusList>

	<SettingsStatusList title={m.admin_settings_content_notes_gate()}>
		<SettingsStatusRow
			label={m.admin_settings_content_notes_ttl()}
			value={String(data.notesGate.ttlDays)}
		/>
	</SettingsStatusList>
</div>

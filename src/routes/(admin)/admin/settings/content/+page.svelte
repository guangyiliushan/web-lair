<script lang="ts">
	import type { PageProps } from './$types';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Field from '$lib/components/ui/field';
	import { SettingsStatusList, SettingsStatusRow } from '$lib/components/admin/settings';

	let { data, form }: PageProps = $props();

	const onOff = (value: boolean) =>
		value ? m.admin_settings_common_on() : m.admin_settings_common_off();
</script>

<svelte:head>
	<title>{m.admin_settings_content_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	{#if form?.message}
		<p class="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
			{form.message}
		</p>
	{/if}

	<section class="rounded-lg border p-4" aria-labelledby="content-comments-title">
		<h2 id="content-comments-title" class="text-sm font-semibold">
			{m.admin_settings_content_comments_section()}
		</h2>
		<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_content_comments_desc()}</p>

		<form method="POST" action="?/saveComments" class="mt-4 flex flex-col gap-4" use:enhance>
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium">{m.admin_settings_content_comments_enable()}</div>
					<div class="text-xs text-muted-foreground">
						{m.admin_settings_content_comments_enable_hint()}
					</div>
				</div>
				<Switch
					name="enabled"
					checked={data.commentsEnabled}
					disabled={!data.editable.comments}
					aria-label={m.admin_settings_content_comments_enable()}
				/>
			</div>
			<p class="text-xs text-muted-foreground">{m.admin_settings_content_comments_closed_note()}</p>
			{#if !data.editable.comments}
				<p class="text-xs text-muted-foreground">{m.admin_settings_common_owner_only()}</p>
			{:else}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{/if}
		</form>

		<div class="mt-4 flex flex-wrap gap-4 border-t border-border/50 pt-3 text-xs">
			<a class="wl-accent-link underline underline-offset-2" href="/admin/comments">
				{m.admin_settings_content_comments_queue_link()}
			</a>
			<a class="wl-accent-link underline underline-offset-2" href="/admin/settings/ai">
				{m.admin_settings_content_comments_triage_link()}
			</a>
		</div>

		<div class="mt-4 border-t border-border/50 pt-4">
			<h3 class="text-sm font-medium">{m.admin_settings_content_privacy()}</h3>
			<form method="POST" action="?/savePrivacy" class="mt-3 flex flex-col gap-4" use:enhance>
				<label class="flex items-start gap-3">
					<input
						type="checkbox"
						name="enabled"
						checked={data.commentsPrivacy.enabled}
						disabled={!data.editable.privacy}
						class="mt-0.5 size-4 accent-primary"
					/>
					<span>
						<span class="text-sm font-medium">{m.admin_settings_content_privacy_enable()}</span>
						<span class="block text-xs text-muted-foreground">
							{m.admin_settings_content_privacy_enable_hint()}
						</span>
					</span>
				</label>
				<label class="flex items-start gap-3">
					<input
						type="checkbox"
						name="collectCountry"
						checked={data.commentsPrivacy.collectCountry}
						disabled={!data.editable.privacy ||
							!data.commentsPrivacy.enabled ||
							!data.geoipConfigured}
						class="mt-0.5 size-4 accent-primary"
					/>
					<span>
						<span class="text-sm font-medium">
							{m.admin_settings_content_privacy_collect()}
						</span>
						<span class="block text-xs text-muted-foreground">
							{m.admin_settings_content_privacy_collect_hint()}
						</span>
						{#if !data.geoipConfigured}
							<span class="block text-xs text-muted-foreground">
								{m.admin_settings_content_privacy_provider_missing()}
							</span>
						{/if}
					</span>
				</label>
				<label class="flex items-start gap-3">
					<input
						type="checkbox"
						name="showCountry"
						checked={data.commentsPrivacy.showCountry}
						disabled={!data.editable.privacy ||
							!data.commentsPrivacy.enabled ||
							!data.commentsPrivacy.collectCountry}
						class="mt-0.5 size-4 accent-primary"
					/>
					<span>
						<span class="text-sm font-medium">{m.admin_settings_content_privacy_show()}</span>
						<span class="block text-xs text-muted-foreground">
							{m.admin_settings_content_privacy_show_hint()}
						</span>
					</span>
				</label>
				<Field.Field>
					<Field.Label for="privacy-retention">
						{m.admin_settings_content_privacy_retention()}
					</Field.Label>
					<Input
						id="privacy-retention"
						name="retentionDays"
						type="number"
						min="1"
						max="3650"
						step="1"
						value={String(data.commentsPrivacy.retentionDays)}
						disabled={!data.editable.privacy}
						class="w-32"
					/>
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_content_privacy_retention_hint()}
					</p>
				</Field.Field>
				<Field.Field>
					<Field.Label for="privacy-cidrs">
						{m.admin_settings_content_privacy_cidrs()}
					</Field.Label>
					<Textarea
						id="privacy-cidrs"
						name="blockedCidrs"
						rows={3}
						value={data.commentsPrivacy.blockedCidrs.join('\n')}
						disabled={!data.editable.privacy}
						placeholder="203.0.113.0/24"
					/>
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_content_privacy_cidrs_hint()}
					</p>
				</Field.Field>
				{#if !data.editable.privacy}
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_content_privacy_owner_hint()}
					</p>
				{:else}
					<div>
						<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
					</div>
				{/if}
			</form>
		</div>

		<div class="mt-4 border-t border-border/50 pt-3">
			<SettingsStatusRow
				label={m.admin_settings_content_moderation()}
				value={onOff(data.moderation)}
			/>
		</div>
	</section>

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

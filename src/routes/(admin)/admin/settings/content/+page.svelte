<script lang="ts">
	import type { PageProps } from './$types';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Field from '$lib/components/ui/field';
	import { SettingsStatusRow } from '$lib/components/admin/settings';

	let { data, form }: PageProps = $props();

	// Live mirrors for the privacy sub-switch chain: collect/show must become
	// tappable the moment the master switch is ticked, not only after a save.
	// `untrack` keeps the initializer a one-shot snapshot (no compile warning);
	// the effect below re-syncs after every successful save.
	let privacyEnabled = $state(untrack(() => data.commentsPrivacy.enabled));
	let privacyCollect = $state(untrack(() => data.commentsPrivacy.collectCountry));
	let privacyShow = $state(untrack(() => data.commentsPrivacy.showCountry));
	$effect(() => {
		privacyEnabled = data.commentsPrivacy.enabled;
		privacyCollect = data.commentsPrivacy.collectCountry;
		privacyShow = data.commentsPrivacy.showCountry;
	});

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
						bind:checked={privacyEnabled}
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
						bind:checked={privacyCollect}
						disabled={!data.editable.privacy || !privacyEnabled || !data.geoipConfigured}
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
						bind:checked={privacyShow}
						disabled={!data.editable.privacy || !privacyEnabled || !privacyCollect}
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

	<section class="rounded-lg border p-4" aria-labelledby="content-friends-title">
		<h2 id="content-friends-title" class="text-sm font-semibold">
			{m.admin_settings_content_friends_section()}
		</h2>
		<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_content_friends_desc()}</p>

		<form method="POST" action="?/saveFriendsApply" class="mt-4 flex flex-col gap-3" use:enhance>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="enabled"
					checked={data.friends.apply.enabled}
					disabled={!data.editable.friends}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span>
					<span class="text-sm font-medium">{m.admin_settings_content_friends_apply()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_settings_content_friends_apply_hint()}
					</span>
				</span>
			</label>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="allowSubPath"
					checked={data.friends.apply.allowSubPath}
					disabled={!data.editable.friends}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span>
					<span class="text-sm font-medium">{m.admin_settings_content_friend_subpaths()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_settings_content_friend_subpaths_hint()}
					</span>
				</span>
			</label>
			{#if data.editable.friends}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{/if}
		</form>

		<form
			method="POST"
			action="?/saveFriendsChecks"
			class="mt-5 flex flex-col gap-3 border-t border-border/50 pt-4"
			use:enhance
		>
			<div>
				<h3 class="text-sm font-medium">{m.admin_settings_content_checks_section()}</h3>
				<p class="text-xs text-muted-foreground">{m.admin_settings_content_checks_desc()}</p>
			</div>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="enabled"
					checked={data.friends.checks.enabled}
					disabled={!data.editable.friends}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span class="text-sm font-medium">{m.admin_settings_content_checks_enabled()}</span>
			</label>
			<div class="grid gap-3 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="checks-cadence">
						{m.admin_settings_content_checks_cadence()}
					</Field.Label>
					<Input
						id="checks-cadence"
						name="cadenceHours"
						type="number"
						min="1"
						step="1"
						value={String(data.friends.checks.cadenceHours)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="checks-fail">
						{m.admin_settings_content_checks_fail()}
					</Field.Label>
					<Input
						id="checks-fail"
						name="failStreak"
						type="number"
						min="1"
						step="1"
						value={String(data.friends.checks.failStreak)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="checks-backlink">
						{m.admin_settings_content_checks_backlink()}
					</Field.Label>
					<Input
						id="checks-backlink"
						name="backlinkStreak"
						type="number"
						min="1"
						step="1"
						value={String(data.friends.checks.backlinkStreak)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="checks-grace">
						{m.admin_settings_content_checks_grace()}
					</Field.Label>
					<Input
						id="checks-grace"
						name="graceDays"
						type="number"
						min="1"
						step="1"
						value={String(data.friends.checks.graceDays)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="checks-timeout">
						{m.admin_settings_content_checks_timeout()}
					</Field.Label>
					<Input
						id="checks-timeout"
						name="timeoutMs"
						type="number"
						min="1000"
						max="60000"
						step="500"
						value={String(data.friends.checks.timeoutMs)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="checks-concurrency">
						{m.admin_settings_content_checks_concurrency()}
					</Field.Label>
					<Input
						id="checks-concurrency"
						name="concurrency"
						type="number"
						min="1"
						max="16"
						step="1"
						value={String(data.friends.checks.concurrency)}
						disabled={!data.editable.friends}
					/>
				</Field.Field>
			</div>
			{#if data.editable.friends}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{/if}
		</form>

		<form
			method="POST"
			action="?/saveFriendsPolicy"
			class="mt-5 flex flex-col gap-3 border-t border-border/50 pt-4"
			use:enhance
		>
			<div>
				<h3 class="text-sm font-medium">{m.admin_settings_content_policy_section()}</h3>
				<p class="text-xs text-muted-foreground">{m.admin_settings_content_policy_desc()}</p>
			</div>
			<Field.Field>
				<Field.Label for="policy-hosts">{m.admin_settings_content_policy_hosts()}</Field.Label>
				<Textarea
					id="policy-hosts"
					name="blockedHostSuffixes"
					rows={3}
					value={data.friends.policy.blockedHostSuffixes.join('\n')}
					disabled={!data.editable.friends}
				/>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_content_policy_list_hint()}
				</p>
			</Field.Field>
			<Field.Field>
				<Field.Label for="policy-tlds">{m.admin_settings_content_policy_tlds()}</Field.Label>
				<Textarea
					id="policy-tlds"
					name="blockedTlds"
					rows={2}
					value={data.friends.policy.blockedTlds.join('\n')}
					disabled={!data.editable.friends}
				/>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_content_policy_list_hint()}
				</p>
			</Field.Field>
			<Field.Field>
				<Field.Label for="policy-accepted">
					{m.admin_settings_content_policy_accepted()}
				</Field.Label>
				<Textarea
					id="policy-accepted"
					name="acceptedBacklinkHosts"
					rows={2}
					value={data.friends.policy.acceptedBacklinkHosts.join('\n')}
					disabled={!data.editable.friends}
				/>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_content_policy_list_hint()}
				</p>
			</Field.Field>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="publicBannedList"
					checked={data.friends.policy.publicBannedList}
					disabled={!data.editable.friends}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span class="text-sm font-medium">{m.admin_settings_content_policy_public()}</span>
			</label>
			{#if data.editable.friends}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">{m.admin_settings_common_owner_only()}</p>
			{/if}
		</form>

		<div class="mt-4 border-t border-border/50 pt-3 text-xs">
			<a class="wl-accent-link underline underline-offset-2" href="/admin/friends">
				{m.admin_settings_content_friends_console()}
			</a>
		</div>
	</section>

	<section class="rounded-lg border p-4" aria-labelledby="content-presence-title">
		<h2 id="content-presence-title" class="text-sm font-semibold">
			{m.admin_settings_content_presence()}
		</h2>
		<p class="mt-1 text-xs text-muted-foreground">
			{m.admin_settings_content_presence_desc()}
		</p>
		<form method="POST" action="?/savePresence" class="mt-4 flex flex-col gap-3" use:enhance>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="enabled"
					checked={data.presence.enabled}
					disabled={!data.editable.presence}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span>
					<span class="text-sm font-medium">{m.admin_settings_content_presence()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_settings_content_presence_enable_hint()}
					</span>
				</span>
			</label>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="readerView"
					checked={data.presence.readerView}
					disabled={!data.editable.presence}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span>
					<span class="text-sm font-medium">{m.admin_settings_content_reader_view()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_settings_content_reader_view_hint()}
					</span>
				</span>
			</label>
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="readerDots"
					checked={data.presence.readerDots}
					disabled={!data.editable.presence}
					class="mt-0.5 size-4 accent-primary"
				/>
				<span>
					<span class="text-sm font-medium">{m.admin_settings_content_reader_dots()}</span>
					<span class="block text-xs text-muted-foreground">
						{m.admin_settings_content_reader_dots_hint()}
					</span>
				</span>
			</label>
			{#if data.editable.presence}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">{m.admin_settings_common_owner_only()}</p>
			{/if}
		</form>
	</section>

	<section class="rounded-lg border p-4" aria-labelledby="content-notes-title">
		<h2 id="content-notes-title" class="text-sm font-semibold">
			{m.admin_settings_content_notes_gate()}
		</h2>
		<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_content_notes_desc()}</p>
		<form method="POST" action="?/saveNotesGate" class="mt-4 flex flex-col gap-3" use:enhance>
			<Field.Field>
				<Field.Label for="notes-ttl">{m.admin_settings_content_notes_ttl()}</Field.Label>
				<Input
					id="notes-ttl"
					name="ttlDays"
					type="number"
					min="1"
					max="3650"
					step="1"
					value={String(data.notesGate.ttlDays)}
					disabled={!data.editable.notes}
					class="w-32"
				/>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_content_notes_ttl_hint()}
				</p>
			</Field.Field>
			{#if data.editable.notes}
				<div>
					<Button type="submit" size="sm">{m.admin_settings_content_save()}</Button>
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">{m.admin_settings_common_owner_only()}</p>
			{/if}
		</form>
	</section>
</div>

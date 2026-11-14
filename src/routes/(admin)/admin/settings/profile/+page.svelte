<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		SettingsForm,
		SettingsStatusList,
		SettingsStatusRow
	} from '$lib/components/admin/settings';
	import { SOCIAL_PRESETS, SOCIAL_USER_PLATFORMS } from '$lib/config/social';
	import type { ProfileLink } from '$lib/server/db/account';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';

	let { data, form }: PageProps = $props();

	const profile = $derived(data.view.profile);
	const formState = $derived(
		form as {
			message?: string | null;
			step?: string;
			ok?: boolean;
			profile?: {
				displayName: string;
				headerLabel: string | null;
				avatarUrl: string | null;
				links: ProfileLink[] | null;
			};
		} | null
	);

	let displayName = $state(untrack(() => profile?.displayName ?? ''));
	let headerLabel = $state(untrack(() => profile?.headerLabel ?? ''));
	let avatarUrl = $state(untrack(() => profile?.avatarUrl ?? ''));
	let links = $state<ProfileLink[]>(
		untrack(() => (profile?.links ?? []).map((link) => ({ ...link })))
	);

	const initial = $derived(
		JSON.stringify({
			displayName: profile?.displayName ?? '',
			headerLabel: profile?.headerLabel ?? '',
			avatarUrl: profile?.avatarUrl ?? '',
			links: (profile?.links ?? []).map((link) => ({
				platform: link.platform,
				href: link.href,
				label: link.label ?? ''
			}))
		})
	);
	const current = $derived(
		JSON.stringify({
			displayName,
			headerLabel,
			avatarUrl,
			links: links.map((link) => ({
				platform: link.platform,
				href: link.href,
				label: link.label ?? ''
			}))
		})
	);
	const dirty = $derived(current !== initial);

	const headerPreview = $derived(
		headerLabel.trim() !== ''
			? headerLabel.trim()
			: displayName.trim() || profile?.displayName || ''
	);
	const headerOverrides = $derived(
		headerLabel.trim() !== '' && headerLabel.trim() !== displayName.trim()
	);

	// A successful save returns the normalized row (trimmed label, normalized
	// URL); sync local fields so the form never shows the pre-normalized text.
	$effect(() => {
		const payload = formState;
		if (!payload || payload.step !== 'profile' || payload.ok === false || !payload.profile) return;
		displayName = payload.profile.displayName;
		headerLabel = payload.profile.headerLabel ?? '';
		avatarUrl = payload.profile.avatarUrl ?? '';
		links = (payload.profile.links ?? []).map((link) => ({ ...link }));
	});

	function reset() {
		displayName = profile?.displayName ?? '';
		headerLabel = profile?.headerLabel ?? '';
		avatarUrl = profile?.avatarUrl ?? '';
		links = (profile?.links ?? []).map((link) => ({ ...link }));
	}

	function addLink() {
		if (links.length >= 8) return;
		links = [...links, { platform: 'github', href: '' }];
	}

	function removeLink(index: number) {
		links = links.filter((_, position) => position !== index);
	}
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

	{#if data.editable}
		<SettingsForm
			action="?/save"
			{dirty}
			message={formState?.step === 'profile' ? formState.message : null}
			error={formState?.ok === false}
			onCancel={reset}
		>
			<div class="space-y-8">
				<section>
					<div class="mb-4 flex items-center gap-2">
						<IconUser class="size-5 text-muted-foreground" />
						<h3 class="text-base font-semibold">{m.admin_settings_profile_identity()}</h3>
					</div>
					<p class="mb-4 text-sm text-muted-foreground">
						{m.admin_settings_user_intro()}
					</p>

					<div class="grid gap-4 sm:grid-cols-2">
						<label class="flex flex-col gap-1.5 text-sm">
							<span class="font-medium">{m.admin_settings_profile_full_name()}</span>
							<Input
								name="displayName"
								bind:value={displayName}
								required
								maxlength={80}
								autocomplete="nickname"
							/>
						</label>

						<label class="flex flex-col gap-1.5 text-sm">
							<span class="font-medium">{m.admin_settings_profile_header_label()}</span>
							<div class="flex gap-2">
								<Input
									name="headerLabel"
									bind:value={headerLabel}
									maxlength={64}
									placeholder={m.admin_settings_profile_header_label_placeholder()}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={headerLabel === ''}
									onclick={() => (headerLabel = '')}
								>
									{m.admin_settings_profile_header_label_clear()}
								</Button>
							</div>
							<span class="text-xs text-muted-foreground">
								{m.admin_settings_profile_header_label_hint()}
							</span>
						</label>
					</div>

					<p class="mt-3 text-xs text-muted-foreground" data-slot="header-preview">
						{m.admin_settings_profile_header_shows({ label: headerPreview })}
						{#if headerOverrides}
							<span class="ms-1">
								{m.admin_settings_profile_header_overrides({ name: displayName })}
							</span>
						{/if}
					</p>

					<div class="mt-4 grid gap-4 sm:grid-cols-2">
						<label class="flex flex-col gap-1.5 text-sm">
							<span class="font-medium">{m.admin_settings_user_avatar()}</span>
							<Input
								name="avatarUrl"
								bind:value={avatarUrl}
								placeholder="https://…"
								inputmode="url"
							/>
							<span class="text-xs text-muted-foreground">
								{m.admin_settings_profile_avatar_hint()}
							</span>
						</label>

						<label class="flex flex-col gap-1.5 text-sm">
							<span class="font-medium">{m.admin_settings_user_email()}</span>
							<Input value={data.view.email ?? ''} readonly tabindex={-1} />
							<span class="text-xs text-muted-foreground">
								{m.admin_settings_profile_email_hint()}
							</span>
						</label>
					</div>
				</section>

				<section>
					<div class="mb-4 flex items-center gap-2">
						<IconLink class="size-5 text-muted-foreground" />
						<h3 class="text-base font-semibold">{m.admin_settings_profile_social()}</h3>
						<Badge variant="secondary">{links.length}/8</Badge>
					</div>
					<p class="mb-4 text-sm text-muted-foreground">
						{m.admin_settings_profile_social_desc()}
					</p>

					<div class="space-y-2" data-slot="social-links">
						{#each links as link, index (index)}
							<div class="flex flex-wrap items-center gap-2">
								<select
									name="linkPlatform"
									bind:value={link.platform}
									aria-label={m.admin_settings_profile_social_platform()}
									class="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
								>
									{#each SOCIAL_USER_PLATFORMS as option (option)}
										<option value={option}>{SOCIAL_PRESETS[option].label()}</option>
									{/each}
								</select>
								<Input
									name="linkHref"
									bind:value={link.href}
									class="min-w-48 flex-1"
									placeholder={m.admin_settings_profile_social_href_placeholder()}
									inputmode="url"
								/>
								<input type="hidden" name="linkLabel" value={link.label ?? ''} />
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={m.admin_settings_profile_social_remove()}
									onclick={() => removeLink(index)}
								>
									<IconTrash />
								</Button>
							</div>
						{/each}
					</div>

					<Button
						type="button"
						variant="outline"
						size="sm"
						class="mt-3"
						disabled={links.length >= 8}
						onclick={addLink}
					>
						<IconPlus data-icon="inline-start" />
						{m.admin_settings_profile_social_add()}
					</Button>
					<p class="mt-2 text-xs text-muted-foreground">
						{m.admin_settings_profile_social_hint()}
					</p>
				</section>
			</div>
		</SettingsForm>
	{:else}
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
			<SettingsStatusRow
				label={m.admin_settings_profile_social()}
				value={String((profile?.links ?? []).length)}
			/>
			<SettingsStatusRow
				label={m.admin_settings_user_email()}
				value={data.view.email ?? m.admin_settings_common_not_configured()}
			/>
		</SettingsStatusList>
	{/if}
</div>

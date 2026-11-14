<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button';
	import IconShieldLock from '@tabler/icons-svelte-runes/icons/shield-lock';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconDeviceLaptop from '@tabler/icons-svelte-runes/icons/device-laptop';
	import IconFingerprint from '@tabler/icons-svelte-runes/icons/fingerprint';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconBrandGithub from '@tabler/icons-svelte-runes/icons/brand-github';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Separator from '$lib/components/ui/separator';
	import { SettingsForm } from '$lib/components/admin/settings';
	import IconKey from '@tabler/icons-svelte-runes/icons/key';

	let { data, form }: PageProps = $props();

	// The action payloads are a union (enable / activate / disable / regenerate);
	// this loose view keeps the template readable.
	const actionForm = $derived(
		form as {
			message?: string | null;
			totpURI?: string;
			backupCodes?: string[];
			step?: string;
			error?: boolean;
		} | null
	);

	// The activation flow spans two submits (enable -> activate). The secret and
	// the one-time codes arrive with the first response and must survive a failed
	// activation, so they live in local state instead of being re-read from the
	// current payload - the old template dropped the secret on the first wrong
	// code and never rendered regenerated codes at all (B3.1 review). A
	// `step: 'done'` payload ends the flow and clears them.
	let pendingTotpURI = $state<string | null>(null);
	let pendingBackupCodes = $state<string[]>([]);

	// No-JS fallback: an action response re-renders the page with `form`, so
	// the secret/codes must also be readable from the payload; local state only
	// carries them across a failed activation submit.
	const shownTotpURI = $derived(pendingTotpURI ?? actionForm?.totpURI ?? null);
	const shownBackupCodes = $derived(
		pendingBackupCodes.length ? pendingBackupCodes : (actionForm?.backupCodes ?? [])
	);
	const setupKey = $derived.by(() => {
		const uri = shownTotpURI;
		if (!uri) return null;
		try {
			return new URL(uri).searchParams.get('secret') ?? uri;
		} catch {
			return uri;
		}
	});

	// Content language moved to Profile & Preferences (IA2/W4.7); the account
	// page is security-only.
	const deviceForm = $derived(
		form as {
			message?: string | null;
			step?: string;
			error?: boolean;
		} | null
	);
	const deviceMessage = $derived(deviceForm?.step === 'devices' ? deviceForm.message : null);
	const deviceError = $derived(Boolean(deviceForm?.error));
	const passwordForm = $derived(
		form as {
			message?: string | null;
			step?: string;
			error?: boolean;
		} | null
	);
	const passwordMessage = $derived(passwordForm?.step === 'password' ? passwordForm.message : null);
	const passwordError = $derived(Boolean(passwordForm?.error));
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	const passwordDirty = $derived(
		currentPassword !== '' || newPassword !== '' || confirmPassword !== ''
	);
	function resetPassword() {
		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
	}
	$effect(() => {
		if (passwordForm?.step === 'password' && passwordForm.message && !passwordForm.error)
			resetPassword();
	});
	const passkeyForm = $derived(
		form as {
			message?: string | null;
			step?: string;
			error?: boolean;
		} | null
	);
	const passkeyMessage = $derived(passkeyForm?.step === 'passkey' ? passkeyForm.message : null);
	const passkeyError = $derived(Boolean(passkeyForm?.error));
	let newPasskeyName = $state('');
	let passkeyPending = $state(false);
	let passkeyClientError = $state<string | null>(null);
	let passkeyNotice = $state<string | null>(null);

	async function addPasskey() {
		passkeyClientError = null;
		passkeyNotice = null;
		if (typeof window === 'undefined') return;
		if (typeof PublicKeyCredential === 'undefined' || !window.isSecureContext) {
			passkeyClientError = m.admin_settings_account_passkey_unsupported();
			return;
		}
		passkeyPending = true;
		try {
			const result = await authClient.passkey.addPasskey({
				name: newPasskeyName.trim() || undefined
			});
			if (result.error) {
				const code = (result.error as { code?: string }).code ?? '';
				// A cancelled WebAuthn prompt is not an error the user needs to
				// read; every other failure has one actionable message.
				if (
					code !== 'REGISTRATION_CANCELLED' &&
					code !== 'AUTH_CANCELLED' &&
					code !== 'ERROR_CEREMONY_ABORTED'
				) {
					passkeyClientError =
						code === 'SESSION_NOT_FRESH'
							? m.admin_settings_account_passkey_session_stale()
							: m.admin_settings_account_passkey_add_failed();
				}
				return;
			}
			newPasskeyName = '';
			passkeyNotice = m.admin_settings_account_msg_passkey_added();
			await invalidateAll();
		} catch {
			passkeyClientError = m.admin_settings_account_passkey_add_failed();
		} finally {
			passkeyPending = false;
		}
	}

	let copiedCallback = $state<'github' | 'google' | null>(null);
	let copyFailed = $state(false);
	async function copyCallback(provider: 'github' | 'google', value: string) {
		copyFailed = false;
		try {
			if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
			await navigator.clipboard.writeText(value);
			copiedCallback = provider;
			setTimeout(() => {
				if (copiedCallback === provider) copiedCallback = null;
			}, 2000);
		} catch {
			copyFailed = true;
		}
	}
	$effect(() => {
		const payload = actionForm;
		if (!payload) return;
		if (payload.totpURI) pendingTotpURI = payload.totpURI;
		if (payload.backupCodes?.length) pendingBackupCodes = payload.backupCodes;
		if (payload.step === 'done') {
			pendingTotpURI = null;
			pendingBackupCodes = [];
		}
	});
</script>

<div class="space-y-8">
	<!-- Section: Two-step verification (real feature · B3) -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<IconShieldLock class="size-5 text-muted-foreground" />
				<h3 class="text-base font-semibold">{m.admin_settings_2fa_title()}</h3>
			</div>
			<Badge variant={data.twoFactorEnabled ? 'default' : 'secondary'}>
				{data.twoFactorEnabled
					? m.admin_settings_2fa_status_on()
					: m.admin_settings_2fa_status_off()}
			</Badge>
		</div>
		<p class="mb-2 text-sm text-muted-foreground">{m.admin_settings_2fa_desc()}</p>
		<p class="mb-3 text-xs text-muted-foreground">{m.admin_settings_2fa_scope()}</p>

		{#if actionForm?.message && ['enable', 'activate', 'disable', 'regenerate', 'regenerated', 'done'].includes(actionForm.step ?? '')}
			<div
				class="mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm {actionForm.error
					? 'bg-destructive/10 text-destructive'
					: 'bg-muted'}"
				role={actionForm.error ? 'alert' : 'status'}
			>
				<IconAlertCircle class="size-4 shrink-0" />
				<span>{actionForm.message}</span>
			</div>
		{/if}

		{#if shownTotpURI}
			<div class="space-y-3 rounded-lg border bg-background p-3">
				<p class="text-sm">{m.admin_settings_2fa_scan_hint()}</p>
				<div class="space-y-1">
					<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_secret()}</div>
					<code class="block rounded bg-muted px-2 py-1 text-xs break-all">{setupKey}</code>
				</div>
				<form method="post" action="?/activate" use:enhance class="flex items-end gap-2">
					<Input
						name="code"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						placeholder="123456"
						aria-label={m.admin_settings_2fa_code()}
						required
					/>
					<Button type="submit" size="sm">
						<IconKey data-icon="inline-start" />
						{m.admin_settings_2fa_activate()}
					</Button>
				</form>
			</div>
		{/if}

		{#if shownBackupCodes.length}
			<div class="space-y-2 rounded-lg border bg-background p-3">
				<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_backup_codes()}</div>
				<div class="grid grid-cols-2 gap-1">
					{#each shownBackupCodes as backupCode (backupCode)}
						<code class="rounded bg-muted px-2 py-1 text-xs">{backupCode}</code>
					{/each}
				</div>
			</div>
		{/if}

		{#if data.twoFactorEnabled}
			<div class="flex flex-wrap items-end gap-2">
				<form
					method="post"
					action="?/regenerateBackupCodes"
					use:enhance
					class="flex items-end gap-2"
				>
					<Input
						name="password"
						type="password"
						autocomplete="current-password"
						placeholder={m.admin_settings_2fa_password()}
						aria-label={m.admin_settings_2fa_regenerate_password()}
						required
					/>
					<Button type="submit" variant="outline" size="sm">
						{m.admin_settings_2fa_regenerate()}
					</Button>
				</form>
				<form method="post" action="?/disable" use:enhance class="flex items-end gap-2">
					<Input
						name="password"
						type="password"
						autocomplete="current-password"
						placeholder={m.admin_settings_2fa_password()}
						aria-label={m.admin_settings_2fa_disable_password()}
						required
					/>
					<Button type="submit" variant="outline" size="sm" class="text-destructive">
						{m.admin_settings_2fa_disable()}
					</Button>
				</form>
			</div>
		{:else if !shownTotpURI}
			{#if data.hasPassword}
				<form method="post" action="?/enable" use:enhance class="flex items-end gap-2">
					<Input
						name="password"
						type="password"
						autocomplete="current-password"
						placeholder={m.admin_settings_2fa_password()}
						aria-label={m.admin_settings_2fa_enable_password()}
						required
					/>
					<Button type="submit" size="sm">{m.admin_settings_2fa_enable()}</Button>
				</form>
			{:else}
				<p class="text-sm text-muted-foreground">
					{m.admin_settings_2fa_password_required()}
				</p>
			{/if}
		{/if}
	</section>

	<Separator.Root />

	<!-- Section: Signed-in devices (real session rows · AC10) -->
	<section>
		<div class="mb-4 flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<IconDeviceLaptop class="size-5 text-muted-foreground" />
					<h3 class="text-base font-semibold">{m.admin_settings_account_devices()}</h3>
					<Badge variant="secondary">{data.sessions.length}</Badge>
				</div>
				<p class="mt-1 text-sm text-muted-foreground">
					{m.admin_settings_account_devices_desc()}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.admin_settings_account_devices_lifetime()}
				</p>
			</div>
			{#if data.sessions.length > 1}
				<form
					method="POST"
					action="?/revokeOthers"
					onsubmit={(event) => {
						if (!confirm(m.admin_settings_account_revoke_others_confirm())) event.preventDefault();
					}}
				>
					<Button type="submit" variant="outline" size="sm">
						{m.admin_settings_account_kick_others()}
					</Button>
				</form>
			{/if}
		</div>

		{#if deviceMessage}
			<p
				class="mb-3 text-sm {deviceError ? 'text-destructive' : 'text-muted-foreground'}"
				role={deviceError ? 'alert' : 'status'}
			>
				{deviceMessage}
			</p>
		{/if}

		{#if data.sessions.length === 0}
			<p class="text-sm text-muted-foreground">{m.admin_settings_account_devices_empty()}</p>
		{:else}
			<ul class="divide-y overflow-hidden rounded-lg border">
				{#each data.sessions as session (session.id)}
					<li class="space-y-1 px-4 py-3">
						<div class="flex flex-wrap items-center gap-2">
							<span
								class="min-w-0 flex-1 truncate text-sm font-medium"
								title={session.userAgent ?? ''}
							>
								{session.userAgent ?? m.admin_settings_account_session_unknown()}
							</span>
							{#if session.current}
								<Badge>{m.admin_settings_account_badge_current()}</Badge>
							{:else}
								<Badge variant="secondary">{m.admin_settings_account_badge_other()}</Badge>
								<form
									method="POST"
									action="?/revokeSession"
									onsubmit={(event) => {
										if (!confirm(m.admin_settings_account_revoke_confirm())) event.preventDefault();
									}}
								>
									<input type="hidden" name="id" value={session.id} />
									<Button type="submit" variant="outline" size="sm">
										{m.admin_settings_account_revoke()}
									</Button>
								</form>
							{/if}
							{#if session.current}
								<form
									method="POST"
									action="?/signOut"
									onsubmit={(event) => {
										if (!confirm(m.admin_settings_account_signout_confirm()))
											event.preventDefault();
									}}
								>
									<Button type="submit" variant="outline" size="sm">
										{m.admin_settings_account_signout()}
									</Button>
								</form>
							{/if}
						</div>
						{#if session.current}
							<p class="text-xs text-muted-foreground">
								{m.admin_settings_account_session_current_hint()}
							</p>
						{/if}
						<dl class="grid gap-x-6 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-2">
							<div class="flex gap-1">
								<dt>{m.admin_settings_account_session_ip()}:</dt>
								<dd class="min-w-0 break-words">
									{session.ipAddress ?? m.admin_settings_account_session_unknown()}
								</dd>
							</div>
							<div class="flex gap-1">
								<dt>{m.admin_settings_account_session_created()}:</dt>
								<dd>{session.createdLabel}</dd>
							</div>
							<div class="flex gap-1">
								<dt>{m.admin_settings_account_session_updated()}:</dt>
								<dd>{session.updatedLabel}</dd>
							</div>
							<div class="flex gap-1">
								<dt>{m.admin_settings_account_session_expires()}:</dt>
								<dd>{session.expiresLabel}</dd>
							</div>
						</dl>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<Separator.Root />

	<!-- Section: Change password (real credential · AC3) -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconLock class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">{m.admin_settings_account_password()}</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">
			{m.admin_settings_account_password_desc()}
		</p>

		{#if data.hasPassword}
			<SettingsForm
				action="?/changePassword"
				dirty={passwordDirty}
				message={passwordMessage}
				error={passwordError}
				submitLabel={m.admin_settings_account_password_submit()}
				onCancel={resetPassword}
			>
				<div class="grid gap-3 sm:grid-cols-3">
					<div class="space-y-1.5">
						<label for="account-current-password" class="text-sm">
							{m.admin_settings_account_password_current()}
						</label>
						<Input
							id="account-current-password"
							name="currentPassword"
							type="password"
							autocomplete="current-password"
							required
							bind:value={currentPassword}
						/>
					</div>
					<div class="space-y-1.5">
						<label for="account-new-password" class="text-sm">
							{m.admin_settings_account_password_new()}
						</label>
						<Input
							id="account-new-password"
							name="newPassword"
							type="password"
							autocomplete="new-password"
							minlength={8}
							maxlength={128}
							required
							bind:value={newPassword}
						/>
					</div>
					<div class="space-y-1.5">
						<label for="account-confirm-password" class="text-sm">
							{m.admin_settings_account_password_confirm()}
						</label>
						<Input
							id="account-confirm-password"
							name="confirmPassword"
							type="password"
							autocomplete="new-password"
							minlength={8}
							maxlength={128}
							required
							bind:value={confirmPassword}
						/>
					</div>
				</div>
			</SettingsForm>
		{:else}
			<p class="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
				{m.admin_settings_account_password_unavailable()}
			</p>
		{/if}
	</section>

	<Separator.Root />

	<!-- Section: Passkeys (list/add/rename/delete · AC4) -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconFingerprint class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">{m.admin_settings_account_passkey()}</h3>
		</div>
		<p class="mb-2 text-sm text-muted-foreground">{m.admin_settings_account_passkey_hint()}</p>
		<p class="mb-3 text-xs text-muted-foreground">
			{m.admin_settings_account_passkey_2fa_bypass()}
		</p>

		{#if passkeyMessage}
			<p
				class="mb-3 text-sm {passkeyError ? 'text-destructive' : 'text-muted-foreground'}"
				role={passkeyError ? 'alert' : 'status'}
			>
				{passkeyMessage}
			</p>
		{/if}
		{#if passkeyClientError}
			<p class="mb-3 text-sm text-destructive" role="alert">{passkeyClientError}</p>
		{/if}
		{#if passkeyNotice}
			<p class="mb-3 text-sm text-muted-foreground" role="status">{passkeyNotice}</p>
		{/if}

		<div class="mb-4 flex flex-wrap items-end gap-2">
			<div class="min-w-48 flex-1 space-y-1.5 sm:max-w-xs">
				<label for="account-passkey-name" class="text-sm">
					{m.admin_settings_account_passkey_name()}
				</label>
				<Input
					id="account-passkey-name"
					name="passkeyName"
					maxlength={80}
					placeholder={m.admin_settings_account_passkey_name_ph()}
					bind:value={newPasskeyName}
				/>
			</div>
			<Button type="button" size="sm" onclick={addPasskey} disabled={passkeyPending}>
				<IconKey data-icon="inline-start" />
				{m.admin_settings_account_passkey_add()}
			</Button>
		</div>

		{#if data.passkeys.length === 0}
			<p class="text-sm text-muted-foreground">{m.admin_settings_account_passkey_empty()}</p>
		{:else}
			<ul class="divide-y overflow-hidden rounded-lg border">
				{#each data.passkeys as passkey (passkey.id)}
					<li class="space-y-2 px-4 py-3 text-sm">
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span class="min-w-0 flex-1 truncate font-medium">
								{passkey.name ?? m.admin_settings_account_passkey()}
							</span>
							<span class="text-xs text-muted-foreground">{passkey.deviceType}</span>
							<Badge variant={passkey.backedUp ? 'default' : 'secondary'}>
								{passkey.backedUp
									? m.admin_settings_account_passkey_backed_up()
									: m.admin_settings_account_passkey_not_backed_up()}
							</Badge>
							<span class="text-xs text-muted-foreground">
								{passkey.createdLabel ?? '—'}
							</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<details class="min-w-0">
								<summary class="cursor-pointer text-xs text-muted-foreground">
									{m.admin_settings_account_passkey_rename()}
								</summary>
								<form
									method="POST"
									action="?/renamePasskey"
									class="mt-2 flex flex-wrap items-end gap-2"
								>
									<input type="hidden" name="id" value={passkey.id} />
									<Input
										name="name"
										value={passkey.name ?? ''}
										maxlength={80}
										required
										aria-label={m.admin_settings_account_passkey_name()}
									/>
									<Button type="submit" variant="outline" size="sm">
										{m.admin_settings_account_passkey_save_name()}
									</Button>
								</form>
							</details>
							<form
								method="POST"
								action="?/deletePasskey"
								class="ml-auto"
								onsubmit={(event) => {
									if (!confirm(m.admin_settings_account_passkey_delete_confirm()))
										event.preventDefault();
								}}
							>
								<input type="hidden" name="id" value={passkey.id} />
								<Button type="submit" variant="outline" size="sm" class="text-destructive">
									{m.admin_settings_account_passkey_delete()}
								</Button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<Separator.Root />

	<!-- Section: OAuth (read-only · AC5) -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconBrandGithub class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">{m.admin_settings_account_oauth()}</h3>
		</div>
		<p class="mb-2 text-sm text-muted-foreground">{m.admin_settings_account_oauth_desc()}</p>
		<p class="mb-3 text-xs text-muted-foreground">
			{m.admin_settings_account_oauth_bypass()}
		</p>

		<ul class="divide-y overflow-hidden rounded-lg border">
			<li class="space-y-1 px-4 py-3">
				<div class="flex flex-wrap items-center gap-2">
					<span class="flex-1 text-sm font-medium">
						{m.admin_settings_account_oauth_github()}
					</span>
					<Badge variant={data.oauth.github.configured ? 'default' : 'secondary'}>
						{data.oauth.github.configured
							? m.admin_settings_account_oauth_configured()
							: m.admin_settings_account_oauth_not_configured()}
					</Badge>
				</div>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_account_oauth_github_hint()}
				</p>
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span>{m.admin_settings_account_callback_url()}:</span>
					<code class="min-w-0 break-all">{data.oauth.github.callback}</code>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onclick={() => copyCallback('github', data.oauth.github.callback)}
					>
						{copiedCallback === 'github'
							? m.admin_settings_account_copied()
							: m.admin_settings_account_copy_callback()}
					</Button>
				</div>
			</li>
			<li class="space-y-1 px-4 py-3">
				<div class="flex flex-wrap items-center gap-2">
					<span class="flex-1 text-sm font-medium">
						{m.admin_settings_account_oauth_google()}
					</span>
					<Badge variant="secondary">{m.admin_settings_account_oauth_planned()}</Badge>
				</div>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_account_oauth_google_hint()}
				</p>
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span>{m.admin_settings_account_callback_url()}:</span>
					<code class="min-w-0 break-all">{data.oauth.google.callback}</code>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onclick={() => copyCallback('google', data.oauth.google.callback)}
					>
						{copiedCallback === 'google'
							? m.admin_settings_account_copied()
							: m.admin_settings_account_copy_callback()}
					</Button>
				</div>
			</li>
		</ul>
		{#if copyFailed}
			<p class="mt-2 text-xs text-destructive" role="alert">
				{m.admin_settings_account_copy_failed()}
			</p>
		{/if}
	</section>
</div>

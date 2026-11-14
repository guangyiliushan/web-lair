<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import IconShieldLock from '@tabler/icons-svelte-runes/icons/shield-lock';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconDeviceLaptop from '@tabler/icons-svelte-runes/icons/device-laptop';
	import IconFingerprint from '@tabler/icons-svelte-runes/icons/fingerprint';
	import IconBrandGithub from '@tabler/icons-svelte-runes/icons/brand-github';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Separator from '$lib/components/ui/separator';
	import { SettingsForm } from '$lib/components/admin/settings';
	import IconGlobe from '@tabler/icons-svelte-runes/icons/globe';
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

	// Content language is a real single-field form; the shared SettingsForm
	// supplies the dirty indicator, Save/Cancel pair, leave-guard and the
	// readable error/success slot. Cancel restores the loaded value.
	const langForm = $derived(
		form as {
			message?: string | null;
			step?: string;
			status?: number;
		} | null
	);
	const deviceForm = $derived(
		form as {
			message?: string | null;
			step?: string;
			status?: number;
		} | null
	);
	const deviceMessage = $derived(deviceForm?.step === 'devices' ? deviceForm.message : null);
	const deviceError = $derived(Boolean(deviceForm?.status && deviceForm.status >= 400));
	let lang = $state<string | null>(null);
	const currentLang = $derived(lang ?? data.defaultLang ?? '');
	const langDirty = $derived(lang !== null && lang !== (data.defaultLang ?? ''));
	const langError = $derived(Boolean(langForm?.status && langForm.status >= 400));

	$effect(() => {
		if (langForm?.step === 'contentLang' && !langForm.status) lang = null;
	});

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
	<!-- Section: Content language (real feature · A4) -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconGlobe class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">{m.admin_settings_account_content_lang()}</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">
			{m.admin_settings_account_content_lang_desc()}
		</p>

		<SettingsForm
			action="?/contentLang"
			dirty={langDirty}
			message={langForm?.step === 'contentLang' ? langForm.message : null}
			error={langError}
			onCancel={() => (lang = null)}
		>
			<select
				name="lang"
				value={currentLang}
				onchange={(event) => (lang = event.currentTarget.value)}
				aria-label={m.admin_settings_account_content_lang()}
				class="h-8 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
			>
				<option value=""
					>{m.admin_settings_account_content_lang_site({
						lang: data.siteDefaultLang
					})}</option
				>
				{#each data.langs as option (option)}
					<option value={option}>{option}</option>
				{/each}
			</select>
		</SettingsForm>
	</section>

	<Separator.Root />

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
		<p class="mb-3 text-sm text-muted-foreground">{m.admin_settings_2fa_desc()}</p>

		{#if actionForm?.message && actionForm.step !== 'contentLang'}
			<div class="mb-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm" role="status">
				<IconAlertCircle class="size-4 shrink-0" />
				<span>{actionForm.message}</span>
			</div>
		{/if}

		{#if pendingTotpURI}
			<div class="space-y-3 rounded-lg border bg-background p-3">
				<p class="text-sm">{m.admin_settings_2fa_scan_hint()}</p>
				<div class="space-y-1">
					<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_secret()}</div>
					<code class="block rounded bg-muted px-2 py-1 text-xs break-all">{pendingTotpURI}</code>
				</div>
				<form method="post" action="?/activate" use:enhance class="flex items-end gap-2">
					<Input
						name="code"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						placeholder="123456"
						required
					/>
					<Button type="submit" size="sm">
						<IconKey data-icon="inline-start" />
						{m.admin_settings_2fa_activate()}
					</Button>
				</form>
			</div>
		{/if}

		{#if pendingBackupCodes.length}
			<div class="space-y-2 rounded-lg border bg-background p-3">
				<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_backup_codes()}</div>
				<div class="grid grid-cols-2 gap-1">
					{#each pendingBackupCodes as backupCode (backupCode)}
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
						required
					/>
					<Button type="submit" variant="outline" size="sm" class="text-destructive">
						{m.admin_settings_2fa_disable()}
					</Button>
				</form>
			</div>
		{:else if !pendingTotpURI}
			<form method="post" action="?/enable" use:enhance class="flex items-end gap-2">
				<Input
					name="password"
					type="password"
					autocomplete="current-password"
					placeholder={m.admin_settings_2fa_password()}
					required
				/>
				<Button type="submit" size="sm">{m.admin_settings_2fa_enable()}</Button>
			</form>
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

	<!-- Section: Passkeys (real rows · AC4; management lands with W8.4) -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconFingerprint class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">{m.admin_settings_account_passkey()}</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">{m.admin_settings_account_passkey_hint()}</p>

		{#if data.passkeys.length === 0}
			<p class="text-sm text-muted-foreground">{m.admin_settings_account_passkey_empty()}</p>
		{:else}
			<ul class="divide-y overflow-hidden rounded-lg border">
				{#each data.passkeys as passkey (passkey.id)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
						<span class="min-w-0 flex-1 truncate font-medium">
							{passkey.name ?? m.admin_settings_account_passkey()}
						</span>
						<Badge variant={passkey.backedUp ? 'default' : 'secondary'}>
							{passkey.backedUp
								? m.admin_settings_account_passkey_backed_up()
								: m.admin_settings_account_passkey_not_backed_up()}
						</Badge>
						<span class="text-xs text-muted-foreground">
							{passkey.createdLabel ?? '—'}
						</span>
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
		<p class="mb-3 text-sm text-muted-foreground">{m.admin_settings_account_oauth_desc()}</p>

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
					{m.admin_settings_account_callback_url()}:
					<code class="break-all">{data.oauth.github.callback}</code>
				</p>
			</li>
			<li class="space-y-1 px-4 py-3">
				<div class="flex flex-wrap items-center gap-2">
					<span class="flex-1 text-sm font-medium">
						{m.admin_settings_account_oauth_google()}
					</span>
					<Badge variant="secondary">{m.admin_settings_account_oauth_planned()}</Badge>
				</div>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_account_callback_url()}:
					<code class="break-all">{data.oauth.google.callback}</code>
				</p>
			</li>
		</ul>
	</section>
</div>

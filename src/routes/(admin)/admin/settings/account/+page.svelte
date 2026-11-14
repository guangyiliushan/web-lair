<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import IconShieldLock from '@tabler/icons-svelte-runes/icons/shield-lock';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
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
</div>

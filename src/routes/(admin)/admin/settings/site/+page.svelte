<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import {
		SettingsForm,
		SettingsProviderStatus,
		SettingsStatusList,
		SettingsStatusRow
	} from '$lib/components/admin/settings';

	let { data, form }: PageProps = $props();

	type SiteOp = 'info' | 'icon' | 'timezone' | 'languages';
	type SiteActionForm = { op?: SiteOp; message?: string; error?: boolean } | null;
	const actionForm = $derived(form as SiteActionForm);
	const messageFor = (op: SiteOp) => (actionForm?.op === op ? (actionForm.message ?? null) : null);
	const errorFor = (op: SiteOp) => actionForm?.op === op && actionForm.error === true;

	// --- Site identity (name / description / avatar) ---
	let name = $state<string | null>(null);
	let description = $state<string | null>(null);
	let avatar = $state<string | null>(null);
	const currentName = $derived(name ?? data.info.name);
	const currentDescription = $derived(description ?? data.info.description);
	const currentAvatar = $derived(avatar ?? data.info.avatar);
	const infoDirty = $derived(
		currentName !== data.info.name ||
			currentDescription !== data.info.description ||
			currentAvatar !== data.info.avatar
	);
	function resetInfo() {
		name = null;
		description = null;
		avatar = null;
	}

	// --- Favicon ---
	let iconUrl = $state<string | null>(null);
	const currentIconUrl = $derived(iconUrl ?? data.icon.url);
	const iconDirty = $derived(currentIconUrl !== data.icon.url);

	// --- Time zone ---
	let tz = $state<string | null>(null);
	const currentTz = $derived(tz ?? data.timezone);
	const tzDirty = $derived(currentTz !== data.timezone);
	// Suggestions only; the server validates against Intl + pg_timezone_names.
	const TZ_SUGGESTIONS = [
		'UTC',
		'Asia/Taipei',
		'Asia/Shanghai',
		'Asia/Tokyo',
		'Asia/Singapore',
		'Europe/London',
		'Europe/Berlin',
		'America/New_York',
		'America/Los_Angeles',
		'Australia/Sydney'
	];

	// --- Languages (owner-only, paired write) ---
	// Mirrors OPTION_LANGS on the server; the generated page data already
	// narrows to this union.
	type SiteLang = 'en' | 'zh-cn' | 'ja';
	let enabledLangs = $state<SiteLang[] | null>(null);
	let defaultLang = $state<SiteLang | null>(null);
	const currentEnabledLangs: SiteLang[] = $derived(enabledLangs ?? data.languages.enabled);
	const currentDefaultLang: SiteLang = $derived(defaultLang ?? data.defaultLang);
	const languagesDirty = $derived(
		currentDefaultLang !== data.defaultLang ||
			currentEnabledLangs.length !== data.languages.enabled.length ||
			currentEnabledLangs.some((lang) => !data.languages.enabled.includes(lang))
	);
	function resetLanguages() {
		enabledLangs = null;
		defaultLang = null;
	}
	function toggleLanguage(lang: SiteLang, checked: boolean) {
		const nextEnabled = data.langs.filter((option) =>
			option === lang ? checked : currentEnabledLangs.includes(option)
		);
		enabledLangs = nextEnabled;
		// The server rejects default ∉ enabled; don't let the client post that
		// pair when the current default is unchecked.
		if (!nextEnabled.includes(currentDefaultLang) && nextEnabled.length > 0) {
			defaultLang = nextEnabled[0];
		}
	}

	// A successful action returns the reloaded data; drop the local edits so
	// the form reflects the stored value (and is clean again). Failed actions
	// keep the user's input.
	$effect(() => {
		const payload = actionForm;
		if (!payload || payload.error) return;
		if (payload.op === 'info') resetInfo();
		if (payload.op === 'icon') iconUrl = null;
		if (payload.op === 'timezone') tz = null;
		if (payload.op === 'languages') resetLanguages();
	});
</script>

<svelte:head>
	<title>{m.admin_settings_site_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<!-- Site identity · S1/S4/S5 -->
	<SettingsForm
		action="?/saveInfo"
		dirty={infoDirty}
		message={messageFor('info')}
		error={errorFor('info')}
		onCancel={resetInfo}
	>
		<fieldset class="space-y-4" disabled={!data.canEditInfo}>
			<legend class="text-sm font-medium">{m.admin_settings_site_identity()}</legend>
			<div class="space-y-1.5">
				<label for="site-name" class="text-sm">{m.admin_settings_site_name()}</label>
				<Input
					id="site-name"
					name="name"
					required
					maxlength={80}
					value={currentName}
					oninput={(event) => (name = event.currentTarget.value)}
				/>
				<p class="text-xs text-muted-foreground">{m.admin_settings_site_name_hint()}</p>
			</div>
			<div class="space-y-1.5">
				<label for="site-description" class="text-sm"
					>{m.admin_settings_site_field_description()}</label
				>
				<Input
					id="site-description"
					name="description"
					maxlength={300}
					value={currentDescription}
					oninput={(event) => (description = event.currentTarget.value)}
				/>
				<p class="text-xs text-muted-foreground">
					{m.admin_settings_site_description_hint()}
				</p>
			</div>
			<div class="space-y-1.5">
				<label for="site-avatar" class="text-sm">{m.admin_settings_site_avatar()}</label>
				<Input
					id="site-avatar"
					name="avatar"
					type="url"
					placeholder="https://…"
					value={currentAvatar}
					oninput={(event) => (avatar = event.currentTarget.value)}
				/>
				<p class="text-xs text-muted-foreground">{m.admin_settings_site_avatar_hint()}</p>
			</div>
		</fieldset>
	</SettingsForm>

	<!-- Favicon · S3 -->
	<SettingsForm
		action="?/saveIcon"
		dirty={iconDirty}
		message={messageFor('icon')}
		error={errorFor('icon')}
		onCancel={() => (iconUrl = null)}
	>
		<fieldset class="space-y-4" disabled={!data.canEditIcon}>
			<legend class="text-sm font-medium">{m.admin_settings_site_icon()}</legend>
			<div class="space-y-1.5">
				<label for="site-icon" class="text-sm">{m.admin_settings_site_icon()}</label>
				<Input
					id="site-icon"
					name="url"
					placeholder="https://… or /i/…"
					value={currentIconUrl}
					oninput={(event) => (iconUrl = event.currentTarget.value)}
				/>
				<p class="text-xs text-muted-foreground">{m.admin_settings_site_icon_hint()}</p>
			</div>
			<dl class="flex items-center justify-between gap-4 text-sm">
				<dt class="text-muted-foreground">{m.admin_settings_site_icon_version()}</dt>
				<dd class="tabular-nums">{data.icon.version}</dd>
			</dl>
		</fieldset>
	</SettingsForm>

	<!-- Languages · owner-only paired write (S7, W5.4) -->
	{#if data.canEditLanguages}
		<SettingsForm
			action="?/saveLanguages"
			dirty={languagesDirty}
			message={messageFor('languages')}
			error={errorFor('languages')}
			onCancel={resetLanguages}
		>
			<fieldset class="space-y-4">
				<legend class="text-sm font-medium">{m.admin_settings_site_languages()}</legend>
				<p class="text-xs text-muted-foreground">{m.admin_settings_site_languages_hint()}</p>
				<div class="space-y-2">
					<span class="block text-sm">{m.admin_settings_site_enabled_languages()}</span>
					{#each data.langs as lang (lang)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="enabled"
								value={lang}
								checked={currentEnabledLangs.includes(lang)}
								onchange={(event) => toggleLanguage(lang, event.currentTarget.checked)}
								class="size-3.5 accent-primary"
							/>
							{lang}
						</label>
					{/each}
				</div>
				<div class="space-y-1.5">
					<label for="site-default-lang" class="text-sm"
						>{m.admin_settings_site_default_lang()}</label
					>
					<select
						id="site-default-lang"
						name="default"
						value={currentDefaultLang}
						onchange={(event) => (defaultLang = event.currentTarget.value as SiteLang)}
						class="h-8 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
					>
						{#each currentEnabledLangs as lang (lang)}
							<option value={lang}>{lang}</option>
						{/each}
					</select>
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_site_default_lang_hint()}
					</p>
				</div>
			</fieldset>
		</SettingsForm>
	{:else}
		<SettingsStatusList
			title={m.admin_settings_site_languages()}
			description={m.admin_settings_site_languages_hint()}
		>
			{#snippet actions()}
				<Badge variant="secondary">{m.admin_settings_common_owner_only()}</Badge>
			{/snippet}
			<SettingsStatusRow
				label={m.admin_settings_site_languages()}
				value={data.languages.enabled.join(', ')}
			/>
			<SettingsStatusRow
				label={m.admin_settings_site_default_lang()}
				value={data.defaultLang}
				hint={m.admin_settings_site_default_lang_hint()}
			/>
		</SettingsStatusList>
	{/if}

	<!-- Time zone -->
	<SettingsForm
		action="?/saveTimezone"
		dirty={tzDirty}
		message={messageFor('timezone')}
		error={errorFor('timezone')}
		onCancel={() => (tz = null)}
	>
		<fieldset class="space-y-4" disabled={!data.canEditTimezone}>
			<legend class="text-sm font-medium">{m.admin_settings_site_timezone()}</legend>
			<div class="space-y-1.5">
				<label for="site-timezone" class="text-sm">{m.admin_settings_site_timezone()}</label>
				<Input
					id="site-timezone"
					name="tz"
					list="site-timezone-suggestions"
					required
					value={currentTz}
					oninput={(event) => (tz = event.currentTarget.value)}
				/>
				<datalist id="site-timezone-suggestions">
					{#each TZ_SUGGESTIONS as suggestion (suggestion)}
						<option value={suggestion}></option>
					{/each}
				</datalist>
				<p class="text-xs text-muted-foreground">{m.admin_settings_site_timezone_hint()}</p>
			</div>
		</fieldset>
	</SettingsForm>

	<!-- Deployment · read-only (S2/S8): no URL editor, no TLS/ACME controls -->
	<SettingsStatusList
		title={m.admin_settings_site_deployment()}
		description={m.admin_settings_site_deployment_hint()}
	>
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

	<!-- Search indexing · read-only (SE1-SE4); real routes only -->
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

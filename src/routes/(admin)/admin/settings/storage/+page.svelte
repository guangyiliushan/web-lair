<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { untrack } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		SettingsForm,
		SettingsProviderStatus,
		SettingsStatusList,
		SettingsStatusRow
	} from '$lib/components/admin/settings';

	let { data, form }: PageProps = $props();

	const provider = $derived(data.provider);
	let driver = $state<'local' | 's3'>(untrack(() => provider.driver));
	let providerType = $state<string>(untrack(() => provider.providerType ?? 'aws-s3'));
	let endpoint = $state(untrack(() => provider.endpoint ?? ''));
	let region = $state(untrack(() => provider.region));
	let bucket = $state(untrack(() => provider.bucket ?? ''));
	let forcePathStyle = $state(untrack(() => provider.forcePathStyle));
	let publicBaseUrl = $state(untrack(() => provider.publicBaseUrl ?? ''));

	// Compare against the LOADED row, not a captured snapshot: after a save the
	// page reloads with the new row, so the form becomes clean by construction.
	const savedProvider = $derived(
		JSON.stringify({
			driver: provider.driver,
			providerType: provider.providerType ?? '',
			endpoint: provider.endpoint ?? '',
			region: provider.region,
			bucket: provider.bucket ?? '',
			forcePathStyle: provider.forcePathStyle,
			publicBaseUrl: provider.publicBaseUrl ?? ''
		})
	);
	const providerDirty = $derived(
		JSON.stringify({
			driver,
			providerType: driver === 'local' ? '' : providerType,
			endpoint: driver === 'local' ? '' : endpoint,
			region,
			bucket: driver === 'local' ? '' : bucket,
			forcePathStyle: driver === 'local' ? true : forcePathStyle,
			publicBaseUrl
		}) !== savedProvider
	);
	// R2 only accepts region "auto"; the hint keeps the form honest before the
	// server rejects it.
	const regionHint = $derived(providerType === 'r2' ? m.admin_settings_storage_ph_auto() : '');

	function resetProvider() {
		driver = provider.driver;
		providerType = provider.providerType ?? 'aws-s3';
		endpoint = provider.endpoint ?? '';
		region = provider.region;
		bucket = provider.bucket ?? '';
		forcePathStyle = provider.forcePathStyle;
		publicBaseUrl = provider.publicBaseUrl ?? '';
	}

	let pendingDays = $state(untrack(() => data.purge.pendingDays));
	let detachedDays = $state(untrack(() => data.purge.detachedDays));
	const purgeDirty = $derived(
		pendingDays !== data.purge.pendingDays || detachedDays !== data.purge.detachedDays
	);

	function resetPurge() {
		pendingDays = data.purge.pendingDays;
		detachedDays = data.purge.detachedDays;
	}

	const providerForm = $derived(form?.step === 'provider' ? form : null);
	const purgeForm = $derived(form?.step === 'purge' ? form : null);
	const testForm = $derived(form?.step === 'test' ? form : null);

	const PROBE_STATUS_KEYS = {
		ok: 'admin_settings_storage_test_ok',
		auth: 'admin_settings_storage_test_auth',
		'not-found': 'admin_settings_storage_test_not_found',
		timeout: 'admin_settings_storage_test_timeout',
		network: 'admin_settings_storage_test_network',
		write: 'admin_settings_storage_test_write',
		capability: 'admin_settings_storage_test_capability',
		unknown: 'admin_settings_storage_test_failed'
	} as const;
	const probeStatusLabel = $derived(
		data.status.lastStatus ? m[PROBE_STATUS_KEYS[data.status.lastStatus]]() : null
	);

	const MIGRATION_STATE_KEYS = {
		idle: 'admin_settings_storage_migration_state_idle',
		copying: 'admin_settings_storage_migration_state_copying',
		copied: 'admin_settings_storage_migration_state_copied',
		failed: 'admin_settings_storage_migration_state_failed',
		cutover: 'admin_settings_storage_migration_state_cutover',
		'rolled-back': 'admin_settings_storage_migration_state_rolled_back'
	} as const;
	const migrationStateLabel = $derived(m[MIGRATION_STATE_KEYS[data.migration.state]]());

	const lastTest = $derived(
		data.status.lastTestAt
			? `${new Date(data.status.lastTestAt).toLocaleString()} · ${
					probeStatusLabel ??
					(data.status.lastTestOk
						? m.admin_settings_common_configured()
						: m.admin_settings_common_error())
				}`
			: m.admin_settings_storage_never_tested()
	);
	const versioningLabel = $derived(
		data.status.bucketVersioning === null
			? m.admin_settings_storage_capability_unknown()
			: data.status.bucketVersioning === 'off'
				? m.admin_settings_common_off()
				: data.status.bucketVersioning === 'enabled'
					? m.admin_settings_common_on()
					: data.status.bucketVersioning
	);
	const lockLabel = $derived(
		data.status.objectLock === null
			? m.admin_settings_storage_capability_unknown()
			: data.status.objectLock
				? m.admin_settings_common_on()
				: m.admin_settings_common_off()
	);
</script>

<svelte:head>
	<title>{m.admin_settings_storage_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center gap-2">
		{#if data.editable}
			<Badge>{m.admin_settings_common_owner_only()}</Badge>
		{:else}
			<Badge variant="secondary">{m.admin_settings_common_read_only()}</Badge>
		{/if}
		<p class="text-xs text-muted-foreground">{m.admin_settings_storage_desc()}</p>
	</div>

	<!-- 1. Live provider (read-only) -->
	<SettingsStatusList title={m.admin_settings_storage_current()}>
		<SettingsStatusRow label={m.admin_settings_storage_driver()} value={data.active.label} />
		<SettingsStatusRow
			label={m.admin_settings_storage_provider_type()}
			value={data.active.config.providerType ?? '—'}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_endpoint()}
			value={data.active.endpoint ?? '—'}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_bucket()}
			value={data.active.bucket ?? m.admin_settings_common_not_configured()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_region()}
			value={data.active.config.region}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_path_style()}
			value={data.active.config.forcePathStyle
				? m.admin_settings_common_on()
				: m.admin_settings_common_off()}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_public_base_url()}
			value={data.active.config.publicBaseUrl ?? '—'}
		/>
		<SettingsStatusRow
			label={m.admin_settings_storage_activated_at()}
			value={data.active.activatedAt ?? '—'}
		/>
		<SettingsStatusRow label={m.admin_settings_storage_versioning()} value={versioningLabel} />
		<SettingsStatusRow label={m.admin_settings_storage_object_lock()} value={lockLabel} />
		<SettingsStatusRow label={m.admin_settings_common_last_test()} value={lastTest} />
		{#if data.status.lastError}
			<SettingsStatusRow label={m.admin_settings_common_error()} value={data.status.lastError} />
		{/if}
	</SettingsStatusList>

	{#if !data.statusMatchesActive}
		<p class="text-xs text-muted-foreground">{m.admin_settings_storage_test_stale()}</p>
	{/if}

	<!-- 2. Provider candidate (owner) -->
	<section class="space-y-3">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="text-sm font-medium">{m.admin_settings_storage_provider()}</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.admin_settings_storage_provider_desc()}
				</p>
			</div>
			{#if data.editable}
				<form method="POST" action="?/testProvider">
					<Button type="submit" size="sm" variant="outline">
						{m.admin_settings_common_test()}
					</Button>
				</form>
			{/if}
		</header>

		{#if testForm?.message}
			<p
				class="text-sm {testForm.ok ? 'text-muted-foreground' : 'text-destructive'}"
				role={testForm.ok ? 'status' : 'alert'}
			>
				{testForm.message}
			</p>
		{/if}

		{#if data.allowPrivateEndpoint}
			<p class="text-xs text-muted-foreground">
				{m.admin_settings_storage_private_allowed()}
			</p>
		{/if}

		{#if data.editable}
			<SettingsForm
				action="?/saveProvider"
				dirty={providerDirty}
				message={providerForm?.message}
				error={providerForm?.ok === false}
				onCancel={resetProvider}
			>
				<div class="space-y-4 rounded-lg border p-4">
					<fieldset class="space-y-2">
						<legend class="text-sm font-medium">{m.admin_settings_storage_driver()}</legend>
						<label class="flex items-center gap-2 text-sm">
							<input type="radio" name="driver" value="local" bind:group={driver} />
							{m.admin_settings_storage_local()}
						</label>
						<label class="flex items-center gap-2 text-sm">
							<input type="radio" name="driver" value="s3" bind:group={driver} />
							{m.admin_settings_storage_external()}
						</label>
						<p class="text-xs text-muted-foreground">
							{driver === 'local'
								? m.admin_settings_storage_local_hint()
								: m.admin_settings_storage_endpoint_hint()}
						</p>
					</fieldset>

					{#if driver === 's3'}
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="space-y-2">
								<Label for="providerType">{m.admin_settings_storage_provider_type()}</Label>
								<select
									id="providerType"
									name="providerType"
									class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
									bind:value={providerType}
								>
									{#each data.providerTypes as type (type)}
										<option value={type}>{type}</option>
									{/each}
								</select>
							</div>
							<div class="space-y-2">
								<Label for="region">{m.admin_settings_storage_region()}</Label>
								<Input id="region" name="region" bind:value={region} autocomplete="off" />
								{#if regionHint}
									<p class="text-xs text-muted-foreground">{regionHint}</p>
								{/if}
							</div>
							<div class="space-y-2 sm:col-span-2">
								<Label for="endpoint">{m.admin_settings_storage_endpoint()}</Label>
								<Input
									id="endpoint"
									name="endpoint"
									bind:value={endpoint}
									placeholder={m.admin_settings_storage_ph_endpoint()}
									autocomplete="off"
								/>
							</div>
							<div class="space-y-2">
								<Label for="bucket">{m.admin_settings_storage_bucket()}</Label>
								<Input id="bucket" name="bucket" bind:value={bucket} autocomplete="off" />
							</div>
							<label class="flex items-start gap-2 pt-6 text-sm">
								<input type="checkbox" name="forcePathStyle" bind:checked={forcePathStyle} />
								<span>
									{m.admin_settings_storage_path_style()}
									<span class="block text-xs text-muted-foreground">
										{m.admin_settings_storage_path_style_hint()}
									</span>
								</span>
							</label>
							<div class="space-y-2 sm:col-span-2">
								<Label for="publicBaseUrl">{m.admin_settings_storage_public_base_url()}</Label>
								<Input
									id="publicBaseUrl"
									name="publicBaseUrl"
									bind:value={publicBaseUrl}
									placeholder="https://cdn.example.com"
									autocomplete="off"
								/>
								<p class="text-xs text-muted-foreground">
									{m.admin_settings_storage_public_base_url_hint()}
								</p>
							</div>
						</div>
					{/if}
				</div>
			</SettingsForm>
		{:else}
			<SettingsStatusList title={m.admin_settings_common_read_only()}>
				<SettingsStatusRow label={m.admin_settings_storage_driver()} value={provider.driver} />
				<SettingsStatusRow
					label={m.admin_settings_storage_provider_type()}
					value={provider.providerType ?? '—'}
				/>
				<SettingsStatusRow
					label={m.admin_settings_storage_endpoint()}
					value={provider.endpoint ?? '—'}
				/>
				<SettingsStatusRow label={m.admin_settings_storage_region()} value={provider.region} />
				<SettingsStatusRow
					label={m.admin_settings_storage_bucket()}
					value={provider.bucket ?? '—'}
				/>
				<SettingsStatusRow
					label={m.admin_settings_storage_public_base_url()}
					value={provider.publicBaseUrl ?? '—'}
				/>
			</SettingsStatusList>
		{/if}
	</section>

	<!-- 3. Credentials (env reference; write-only store lands with W7.6) -->
	<section class="space-y-3">
		<header class="min-w-0">
			<h2 class="text-sm font-medium">{m.admin_settings_storage_credentials()}</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				{m.admin_settings_storage_credentials_env_hint()}
			</p>
		</header>
		<div class="divide-y rounded-lg border">
			<SettingsProviderStatus
				name={`env: ${data.credentials.envNames.accessKeyId}`}
				state={data.credentials.source === 'env' ? 'configured' : 'not_configured'}
				detail={data.credentials.source === 'env'
					? m.admin_settings_storage_credentials_env()
					: m.admin_settings_storage_credentials_missing()}
			/>
			<SettingsProviderStatus
				name={`env: ${data.credentials.envNames.secretAccessKey}`}
				state={data.credentials.source === 'env' ? 'configured' : 'not_configured'}
				detail={m.admin_settings_storage_credentials_never_shown()}
			/>
		</div>
		<p class="text-xs text-muted-foreground">
			{m.admin_settings_storage_local_env()}: RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY ({data.envRefs
				.accessKey === 'set'
				? m.admin_settings_common_configured()
				: m.admin_settings_common_not_configured()})
		</p>
	</section>

	<!-- 4. Migration / cutover (CLI-only; the page never switches) -->
	<section class="space-y-3">
		<header class="min-w-0">
			<h2 class="text-sm font-medium">{m.admin_settings_storage_migration()}</h2>
			<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_storage_migration_desc()}</p>
		</header>
		<SettingsStatusList title={m.admin_settings_storage_migration()}>
			<SettingsStatusRow
				label={m.admin_settings_storage_files_count()}
				value={String(data.fileCount)}
				badge={data.migrationRequired
					? m.admin_settings_storage_migration_required()
					: m.admin_settings_storage_migration_not_required()}
			/>
			<SettingsStatusRow
				label={m.admin_settings_storage_migration_state()}
				value={migrationStateLabel}
			/>
			{#if data.migration.state !== 'idle'}
				<SettingsStatusRow
					label={m.admin_settings_storage_migration_progress()}
					value={`${data.migration.verified}/${data.migration.total}`}
				/>
			{/if}
			{#if data.migration.error}
				<SettingsStatusRow label={m.admin_settings_common_error()} value={data.migration.error} />
			{/if}
		</SettingsStatusList>
		{#if data.migrationRunning}
			<p class="text-sm text-destructive" role="alert">
				{m.admin_settings_storage_migration_running()}
			</p>
		{/if}
		<pre class="overflow-x-auto rounded-lg border bg-muted/30 p-3 text-xs"><code
				>{`pnpm storage:migrate --dry-run
pnpm storage:migrate --yes
pnpm storage:migrate --cutover
pnpm storage:migrate --rollback`}</code
			></pre>
		<p class="text-xs text-muted-foreground">{m.admin_settings_storage_migration_cli()}</p>
	</section>

	<!-- 5. Media purge TTLs (owner) -->
	<section class="space-y-3">
		<header class="min-w-0">
			<h2 class="text-sm font-medium">{m.admin_settings_storage_media_purge()}</h2>
			<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_storage_purge_hint()}</p>
		</header>
		{#if data.editable}
			<SettingsForm
				action="?/savePurge"
				dirty={purgeDirty}
				message={purgeForm?.message}
				error={purgeForm?.ok === false}
				onCancel={resetPurge}
			>
				<div class="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
					<div class="space-y-2">
						<Label for="pendingDays">{m.admin_settings_storage_pending_ttl_days()}</Label>
						<Input
							id="pendingDays"
							name="pendingDays"
							type="number"
							min="1"
							bind:value={pendingDays}
						/>
					</div>
					<div class="space-y-2">
						<Label for="detachedDays">{m.admin_settings_storage_detached_ttl()}</Label>
						<Input
							id="detachedDays"
							name="detachedDays"
							type="number"
							min="1"
							bind:value={detachedDays}
						/>
					</div>
				</div>
			</SettingsForm>
		{:else}
			<SettingsStatusList title={m.admin_settings_common_read_only()}>
				<SettingsStatusRow
					label={m.admin_settings_storage_pending_ttl_days()}
					value={String(data.purge.pendingDays)}
				/>
				<SettingsStatusRow
					label={m.admin_settings_storage_detached_ttl()}
					value={String(data.purge.detachedDays)}
				/>
			</SettingsStatusList>
		{/if}
		<Button variant="outline" size="sm" href="/admin/files" target="_self">
			{m.admin_settings_storage_open_files()}
		</Button>
	</section>

	<!-- 6. Read-only capability map -->
	<section class="space-y-3">
		<header class="min-w-0">
			<h2 class="text-sm font-medium">{m.admin_settings_common_read_only()}</h2>
		</header>
		<SettingsStatusList
			title={m.admin_settings_storage_upload_limits()}
			description={m.admin_settings_storage_upload_limits_hint()}
		>
			<SettingsStatusRow label={m.admin_settings_storage_max_image()} value="25 MB" />
			<SettingsStatusRow label={m.admin_settings_storage_max_per_batch()} value="10" />
			<SettingsStatusRow label={m.admin_settings_storage_max_per_hour()} value="60" />
			<SettingsStatusRow
				label={m.admin_settings_storage_mime()}
				value="image/* + pdf, zip, txt, md"
			/>
		</SettingsStatusList>
	</section>
</div>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as Separator from '$lib/components/ui/separator';
	import {
		AI_FUNCTIONS,
		AI_FUNCTION_LABELS,
		AI_PROVIDER_KINDS,
		AI_PROVIDER_KIND_LABELS,
		AI_PROVIDER_PRESETS,
		enabledModelIds,
		normalizeModelEntries,
		type AiModelEntry,
		type AiProviderKind
	} from '$lib/utils/ai-meta';
	import MemoryCards from '$lib/components/admin/ai/memory-cards.svelte';
	import PricingCard from '$lib/components/admin/ai/pricing-card.svelte';
	import ModelPoolCard from '$lib/components/admin/ai/model-pool-card.svelte';
	import { POOL_MODE } from '$lib/utils/ai-pool';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlugConnected from '@tabler/icons-svelte-runes/icons/plug-connected';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconKey from '@tabler/icons-svelte-runes/icons/key';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	let { data, form }: PageProps = $props();

	type ProviderRow = PageProps['data']['providers'][number];

	// The action payloads are a union; this loose view keeps the template readable.
	const actionForm = $derived(
		form as {
			message?: string;
			providerErrors?: Record<string, string>;
			providerTest?: { id: string; name: string; ok: boolean; message: string };
			/** Row index -> the cell that failed, from `?/savePricing`. */
			pricingErrors?: Record<string, string>;
			/** Compact key for the failing control, from the pool actions. */
			poolErrors?: Record<string, string>;
			/** Diff from `?/previewPricingSync`, which opens the confirm dialog. */
			pricingSync?: {
				added: string[];
				changed: string[];
				kept: string[];
				unresolved: string[];
			};
		} | null
	);
	const providerErrors = $derived(actionForm?.providerErrors ?? null);
	const poolErrors = $derived(actionForm?.poolErrors ?? null);

	// ── Pricing card inputs ──────────────────────────────────────────────
	/**
	 * Keys the app can actually call: every enabled model of every provider plus
	 * whatever the feature assignments point at. The card uses this to offer a
	 * picker instead of free text (a typo in `<provider>/<model>` would silently
	 * unprice the call) and to mark keys that no longer map to anything.
	 */
	const pricingKeys = $derived.by(() => {
		// A plain array, deduped on insert: the list is a handful of keys, and a
		// SvelteSet here would only add a reactive wrapper nothing observes.
		const keys: string[] = [];
		const add = (key: string) => {
			if (!keys.includes(key)) keys.push(key);
		};
		for (const provider of data.providers) {
			// DeepL prices characters; its model list is a quality tier, not a
			// token model, so it is not a token-price candidate.
			for (const entry of normalizeModelEntries(provider.models)) {
				if (entry.enabled) add(`${provider.name}/${entry.id}`);
			}
		}
		for (const slot of Object.values(data.assignments ?? {})) {
			if (slot?.provider && slot.model) add(`${slot.provider}/${slot.model}`);
		}
		return keys.sort((a, b) => a.localeCompare(b));
	});
	const pricingErrors = $derived(actionForm?.pricingErrors ?? null);
	const pricingSync = $derived(actionForm?.pricingSync ?? null);

	// ── Provider dialog state ────────────────────────────────────────────
	let dialogOpen = $state(false);
	/**
	 * Provider dialog element. The kind Select lives inside this dialog and
	 * must portal its layer INTO the dialog DOM, or the dialog's dismiss layer
	 * reads the dropdown as an outside click (UX-1020-02).
	 */
	let providerDialogEl = $state<HTMLElement | null>(null);
	let editing = $state<ProviderRow | null>(null);
	let savingProvider = $state(false);
	let refreshingModels = $state(false);
	/** Result copy for the dialog; the page-level alert sits behind the modal. */
	let refreshMessage = $state('');
	let fieldName = $state('');
	let fieldPreset = $state('');
	let fieldKind = $state<string>('openai-compatible');
	let fieldBaseUrl = $state('');
	let fieldApiKeyEnv = $state('');
	let fieldModels = $state('');
	let fieldDiscovered = $state<AiModelEntry[]>([]);
	let fieldEnabled = $state(true);
	/** Search + manual-add state for the model picker in the dialog. */
	let modelSearch = $state('');
	let manualModelOpen = $state(false);
	let manualModelId = $state('');
	let deleteTarget = $state<ProviderRow | null>(null);
	/** Write-only key dialog target (W2.5); the value never enters page state. */
	let keyTarget = $state<ProviderRow | null>(null);

	const enabledInDialog = $derived(
		new Set(
			fieldModels
				.split(/[\n,]/)
				.map((id) => id.trim())
				.filter(Boolean)
		)
	);
	// Stored/discovered entries plus any enabled id that has no entry yet
	// (manual ids), so the picker always shows what the form will save.
	const modelChoices = $derived.by(() => {
		const choices = [...fieldDiscovered];
		for (const id of enabledInDialog) {
			if (!choices.some((entry) => entry.id === id)) {
				choices.push({ id, enabled: true, source: 'manual' });
			}
		}
		return choices;
	});
	const filteredModels = $derived.by(() => {
		const query = modelSearch.trim().toLowerCase();
		return query
			? modelChoices.filter((entry) => entry.id.toLowerCase().includes(query))
			: modelChoices;
	});

	function toggleModel(id: string, checked: boolean) {
		const ids = [...enabledInDialog].filter((entry) => entry !== id);
		if (checked) ids.push(id);
		fieldModels = ids.join('\n');
	}

	function addManualModel() {
		const id = manualModelId.trim();
		if (!id) return;
		if (!enabledInDialog.has(id)) fieldModels = [...enabledInDialog, id].join('\n');
		manualModelId = '';
	}

	function applyPreset(id: string) {
		const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
		if (!preset) return;
		if (!fieldName.trim()) fieldName = preset.label;
		fieldKind = preset.kind;
		fieldBaseUrl = preset.baseUrl;
		if (!fieldApiKeyEnv.trim()) fieldApiKeyEnv = preset.apiKeyEnvHint;
	}

	function openCreate() {
		editing = null;
		fieldName = '';
		fieldPreset = '';
		fieldKind = 'openai-compatible';
		fieldBaseUrl = '';
		fieldApiKeyEnv = '';
		fieldModels = '';
		fieldDiscovered = [];
		fieldEnabled = true;
		refreshMessage = '';
		modelSearch = '';
		manualModelOpen = false;
		manualModelId = '';
		dialogOpen = true;
	}

	function openEdit(provider: ProviderRow) {
		editing = provider;
		fieldName = provider.name;
		fieldPreset = '';
		fieldKind = provider.kind;
		fieldBaseUrl = provider.baseUrl ?? '';
		fieldApiKeyEnv = provider.apiKeyEnv ?? '';
		fieldModels = enabledModelIds(provider.models).join('\n');
		fieldDiscovered = normalizeModelEntries(provider.models);
		fieldEnabled = provider.enabled;
		refreshMessage = '';
		modelSearch = '';
		manualModelOpen = false;
		manualModelId = '';
		dialogOpen = true;
	}

	// ── Assignments / moderation / budget / style-guide state ───────────
	/**
	 * One mode select per slot, plus a model select that only matters when a
	 * gateway is pinned:
	 *
	 *  - 关闭          -> nothing stored, the slot is off;
	 *  - 使用默认聚合  -> stored as `{}`: the slot runs the pool from the top;
	 *  - <provider>    -> stored as `{ provider, model }`: that exact pair runs
	 *                     first, and the pool is still the fallback.
	 *
	 * Seeded synchronously (not only through the effect below) because the page
	 * is server-rendered, and an empty map would reach the template as undefined.
	 */
	function assignmentState(source: typeof data.assignments): {
		providers: Record<string, string>;
		models: Record<string, string>;
	} {
		const providers: Record<string, string> = {};
		const models: Record<string, string> = {};
		for (const fn of AI_FUNCTIONS) {
			const entry = source[fn];
			// A stored `{ model }` has no gateway to show, so it reads as pool
			// mode; the runtime keeps honouring the stored pin until it is saved.
			providers[fn] = !entry ? '' : (entry.provider ?? POOL_MODE);
			models[fn] = entry?.model ?? '';
		}
		return { providers, models };
	}
	const assignmentSeed = untrack(() => assignmentState(data.assignments));
	let assignProviders = $state<Record<string, string>>(assignmentSeed.providers);
	let assignModels = $state<Record<string, string>>(assignmentSeed.models);

	/** First enabled model of a gateway: what a fresh pin should default to. */
	function firstModel(providerName: string): string | null {
		const models = data.providers.find((p) => p.name === providerName)?.models ?? null;
		return enabledModelIds(models)[0] ?? null;
	}
	let mod = $state(untrack(() => ({ ...data.moderation })));
	let modKeywords = $state('');
	let modRegexes = $state('');
	let modTrusted = $state('');
	let budget = $state(untrack(() => ({ ...data.budget })));
	let alertRatiosText = $state('');
	let styleGuideText = $state('');
	let translation = $state(untrack(() => ({ ...data.translation })));
	let summaryOpt = $state(untrack(() => ({ ...data.summary })));
	let crawl = $state(untrack(() => ({ ...data.crawl })));
	// The pricing card owns its own row state (and its advanced JSON copy), so
	// there is nothing to mirror here any more.
	const dirtyForms = $state<Record<string, boolean>>({});

	// Re-sync the local copies whenever a load hands us new data (a save, a
	// provider delete cascade, …) so the form never shows stale values - but
	// never while a form is dirty.
	$effect(() => {
		// Read the sockets first so the effect stays subscribed even when the
		// dirty branch below returns early.
		const freshAssignments = data.assignments;
		const freshModeration = data.moderation;
		const freshBudget = data.budget;
		const freshStyleGuide = data.styleGuide;
		const freshTranslation = data.translation;
		const freshSummary = data.summary;
		const freshCrawl = data.crawl;
		if (Object.values(dirtyForms).some(Boolean)) return;
		const next = assignmentState(freshAssignments);
		assignProviders = next.providers;
		assignModels = next.models;
		mod = { ...freshModeration };
		modKeywords = freshModeration.keywords.join('\n');
		modRegexes = freshModeration.regexes.join('\n');
		modTrusted = freshModeration.trustedUsers.join('\n');
		budget = { ...freshBudget };
		alertRatiosText = freshBudget.alertRatios.join(', ');
		styleGuideText = freshStyleGuide.text;
		translation = { ...freshTranslation };
		summaryOpt = { ...freshSummary };
		crawl = { ...freshCrawl };
	});

	const kindPlaceholder: Record<string, string> = {
		'openai-compatible': 'https://api.openai.com/v1',
		deepl: 'https://api.deepl.com/v2',
		custom: 'https://your-gateway.example.com'
	};
</script>

<svelte:head>
	<title>{m.admin_settings_ai_title()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-8">
	{#if actionForm?.message}
		<Alert.Root>
			<Alert.Title>{actionForm.message}</Alert.Title>
		</Alert.Root>
	{/if}

	{#if !data.canManage}
		<Alert.Root>
			<IconInfoCircle />
			<Alert.Title>{m.admin_settings_ai_owner_only()}</Alert.Title>
		</Alert.Root>
	{/if}

	<!-- ── Providers ──────────────────────────────────────────────────── -->
	<section id="providers" class="flex flex-col gap-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="text-base font-medium">{m.admin_settings_ai_providers()}</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.admin_settings_ai_providers_desc()}
				</p>
			</div>
			{#if data.canManage}
				<Button type="button" variant="outline" size="sm" onclick={openCreate}>
					<IconPlus data-icon="inline-start" />
					{m.admin_settings_ai_add_provider()}
				</Button>
			{/if}
		</header>

		{#if actionForm?.providerTest}
			<Alert.Root variant={actionForm.providerTest.ok ? 'default' : 'destructive'}>
				<IconPlugConnected />
				<Alert.Title
					>{m.admin_settings_ai_test_title({ name: actionForm.providerTest.name })}</Alert.Title
				>
				<Alert.Description>{actionForm.providerTest.message}</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- The pool is the first row of this list, not a section of its own: both
		     cards answer "which model will actually run", and the pool is simply
		     the answer the providers add up to. -->
		<div class="flex flex-col gap-2">
			<ModelPoolCard
				rows={data.pool}
				providers={data.providers}
				canManage={data.canManage}
				errors={poolErrors}
			/>
			{#if data.providers.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon">
							<IconSettings />
						</Empty.Media>
						<Empty.Title>{m.admin_settings_ai_empty()}</Empty.Title>
						<Empty.Description>{m.admin_settings_ai_empty_desc()}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				{#each data.providers as provider (provider.id)}
					<div class="flex flex-wrap items-center gap-3 rounded-lg border p-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate text-sm font-medium">{provider.name}</span>
								<Badge variant="secondary"
									>{AI_PROVIDER_KIND_LABELS[provider.kind as AiProviderKind][getLocale()]}</Badge
								>
								{#if provider.enabled}
									<Badge>{m.admin_common_enable()}</Badge>
								{:else}
									<Badge variant="outline">{m.admin_common_disable()}</Badge>
								{/if}
							</div>
							<div
								class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
							>
								{#if provider.baseUrl}
									<span class="max-w-64 truncate">{provider.baseUrl}</span>
								{/if}
								{#if provider.apiKeyEnv}
									<span class="inline-flex items-center gap-1">
										<IconKey class="size-3" />
										{provider.apiKeyEnv}
										{#if data.envSet[provider.id]}
											<Badge variant="secondary">{m.admin_settings_ai_env_set()}</Badge>
										{:else}
											<Badge variant="destructive">{m.admin_settings_ai_env_unset()}</Badge>
										{/if}
									</span>
								{/if}
								{#if data.providerKeys[provider.id]?.configured}
									<span class="inline-flex items-center gap-1">
										<IconKey class="size-3" />
										{data.providerKeys[provider.id]?.hint}
										<Badge variant="secondary">{m.admin_settings_ai_key_badge_db()}</Badge>
									</span>
								{:else}
									<span class="inline-flex items-center gap-1">
										<IconKey class="size-3" />
										{m.admin_settings_ai_key_not_configured()}
									</span>
								{/if}
								{#if provider.models?.length}
									<span
										>{m.admin_settings_ai_model_count({
											count: enabledModelIds(provider.models).length
										})}</span
									>
								{/if}
							</div>
						</div>
						<div class="flex shrink-0 flex-wrap items-center gap-2">
							<form method="post" action="?/testProvider" use:enhance>
								<input type="hidden" name="id" value={provider.id} />
								<Button type="submit" variant="outline" size="sm">
									<IconPlugConnected data-icon="inline-start" />
									{m.admin_settings_ai_test()}
								</Button>
							</form>
							{#if data.canManage}
								<Button variant="outline" size="sm" onclick={() => (keyTarget = provider)}>
									<IconKey data-icon="inline-start" />
									{m.admin_settings_ai_key_button()}
								</Button>
								<Button variant="outline" size="sm" onclick={() => openEdit(provider)}>
									<IconPencil data-icon="inline-start" />
									{m.admin_common_edit()}
								</Button>
								<Button variant="destructive" size="sm" onclick={() => (deleteTarget = provider)}>
									<IconTrash data-icon="inline-start" />
									{m.admin_common_delete()}
								</Button>
							{/if}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</section>

	<Separator.Root />

	<!-- ── Feature assignments ────────────────────────────────────────── -->
	<section id="assignments" class="flex flex-col gap-4">
		<header>
			<h2 class="text-base font-medium">{m.admin_settings_ai_assignments()}</h2>
		</header>
		<form
			method="post"
			action="?/saveAssignments"
			class="flex flex-col gap-4"
			oninput={() => (dirtyForms.assignments = true)}
			onchange={() => (dirtyForms.assignments = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.assignments = false;
					await update();
				}}
		>
			{#each AI_FUNCTIONS as fn (fn)}
				{@const mode = assignProviders[fn] ?? ''}
				{@const assigned = assignModels[fn] ?? ''}
				{@const pinned = mode && mode !== POOL_MODE ? mode : null}
				<!-- Pool mode lists the pool, in pool order: naming one of them is a
				     per-slot head start, not a different way of resolving. Disabled
				     rows are left out; a slot still pointing at one keeps it below. -->
				{@const options = pinned
					? enabledModelIds(data.providers.find((p) => p.name === pinned)?.models ?? null)
					: data.pool.filter((row) => row.enabled).map((row) => row.model)}
				{@const nothingToPick = options.length === 0 && !assigned}
				<div class="grid items-center gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]">
					<div class="text-sm font-medium">{AI_FUNCTION_LABELS[fn][getLocale()]}</div>
					<Select.Root
						type="single"
						name={`provider_${fn}`}
						bind:value={assignProviders[fn]}
						onValueChange={(value) => {
							assignProviders[fn] = value;
							// Switching to a gateway preselects its first model, so the
							// row is valid without a second click; pool mode starts with
							// no head start, which is the common case.
							assignModels[fn] = value && value !== POOL_MODE ? (firstModel(value) ?? '') : '';
							dirtyForms.assignments = true;
						}}
					>
						<Select.Trigger class="w-full">
							{mode === ''
								? m.admin_settings_ai_provider_off()
								: mode === POOL_MODE
									? m.admin_settings_ai_provider_auto()
									: mode}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">{m.admin_settings_ai_provider_off()}</Select.Item>
							<Select.Item value={POOL_MODE}>{m.admin_settings_ai_provider_auto()}</Select.Item>
							{#each data.providers as p (p.id)}
								<Select.Item value={p.name}>{p.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<!-- Always rendered, even when the slot is off: a column that appears
					     and disappears with the mode makes the form jump, and a missing
					     cell reads as "unfinished" rather than "not applicable". Off
					     renders as a disabled box holding an em dash, which says the
					     same thing without moving anything. -->
					<Select.Root
						type="single"
						name={`model_${fn}`}
						bind:value={assignModels[fn]}
						disabled={mode === '' || (pinned !== null && nothingToPick)}
						onValueChange={() => (dirtyForms.assignments = true)}
					>
						<Select.Trigger class="w-full">
							{#if mode === ''}
								<span aria-hidden="true">—</span>
								<span class="sr-only">{m.admin_settings_ai_assign_off_hint()}</span>
							{:else}
								{assigned ||
									(options.length
										? mode === POOL_MODE
											? m.admin_settings_ai_model_pool_order()
											: m.admin_settings_ai_model_pick()
										: m.admin_settings_ai_models_none())}
							{/if}
						</Select.Trigger>
						<Select.Content>
							{#if mode === POOL_MODE}
								<!-- No head start: run the pool exactly as ordered. -->
								<Select.Item value="">{m.admin_settings_ai_model_pool_order()}</Select.Item>
							{/if}
							{#each options as model (model)}
								<Select.Item value={model}>{model}</Select.Item>
							{/each}
							<!-- A model that was disabled after being assigned stays
							     visible, so the row explains itself instead of silently
							     reading as "unassigned". -->
							{#if assigned && !options.includes(assigned)}
								<Select.Item value={assigned}>{assigned}</Select.Item>
							{/if}
						</Select.Content>
					</Select.Root>
				</div>
			{/each}
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_assignments()}
				</Button>
			</div>
		</form>
	</section>

	<Separator.Root />

	<!-- ── Toggles and thresholds ─────────────────────────────────────── -->
	<section class="flex flex-col gap-6">
		<header>
			<h2 class="text-base font-medium">{m.admin_settings_ai_switches()}</h2>
			<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_ai_switches_desc()}</p>
		</header>

		<Alert.Root>
			<IconInfoCircle />
			<Alert.Title>{m.admin_settings_ai_frozen_title()}</Alert.Title>
			<Alert.Description>
				{m.admin_settings_ai_frozen_desc()}
			</Alert.Description>
		</Alert.Root>

		<!-- Comment triage -->
		<form
			id="guards"
			method="post"
			action="?/saveModeration"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirtyForms.moderation = true)}
			onchange={() => (dirtyForms.moderation = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.moderation = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_triage()}</h3>
			<div class="flex flex-col gap-3">
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">{m.admin_settings_ai_triage_enabled()}</div>
						<div class="text-xs text-muted-foreground">{m.admin_settings_ai_triage_hint()}</div>
					</div>
					<Switch
						name="enabled"
						bind:checked={mod.enabled}
						onCheckedChange={() => (dirtyForms.moderation = true)}
						aria-label={m.admin_settings_ai_triage_enabled()}
					/>
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">{m.admin_settings_ai_shadow()}</div>
						<div class="text-xs text-muted-foreground">{m.admin_settings_ai_shadow_hint()}</div>
					</div>
					<Switch
						name="shadowMode"
						bind:checked={mod.shadowMode}
						onCheckedChange={() => (dirtyForms.moderation = true)}
						aria-label={m.admin_settings_ai_shadow()}
					/>
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">{m.admin_settings_ai_first_comment()}</div>
						<div class="text-xs text-muted-foreground">
							{m.admin_settings_ai_first_comment_hint()}
						</div>
					</div>
					<Switch
						name="firstCommentHold"
						bind:checked={mod.firstCommentHold}
						onCheckedChange={() => (dirtyForms.moderation = true)}
						aria-label={m.admin_settings_ai_first_comment()}
					/>
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field.Field>
						<Field.Label for="mod-link-threshold"
							>{m.admin_settings_ai_link_threshold()}</Field.Label
						>
						<Input
							id="mod-link-threshold"
							name="linkThreshold"
							type="number"
							min="0"
							step="1"
							bind:value={mod.linkThreshold}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="mod-allow">{m.admin_settings_ai_allow_threshold()}</Field.Label>
						<Input
							id="mod-allow"
							name="allow"
							type="number"
							min="0"
							max="1"
							step="0.05"
							bind:value={mod.thresholds.allow}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="mod-block">{m.admin_settings_ai_block_threshold()}</Field.Label>
						<Input
							id="mod-block"
							name="block"
							type="number"
							min="0"
							max="1"
							step="0.05"
							bind:value={mod.thresholds.block}
						/>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="mod-keywords">{m.admin_settings_ai_keywords()}</Field.Label>
					<Textarea id="mod-keywords" name="keywords" rows={3} bind:value={modKeywords} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="mod-regexes">{m.admin_settings_ai_regexes()}</Field.Label>
					<Textarea id="mod-regexes" name="regexes" rows={3} bind:value={modRegexes} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="mod-trusted">{m.admin_settings_ai_trusted()}</Field.Label>
					<Textarea id="mod-trusted" name="trustedUsers" rows={2} bind:value={modTrusted} />
				</Field.Field>
			</div>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_moderation()}
				</Button>
			</div>
		</form>

		<!-- Budget -->
		<form
			id="cost"
			method="post"
			action="?/saveBudget"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirtyForms.budget = true)}
			onchange={() => (dirtyForms.budget = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.budget = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_budget()}</h3>
			<div class="grid gap-3 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="budget-monthly">{m.admin_settings_ai_budget_monthly()}</Field.Label>
					<Input
						id="budget-monthly"
						name="monthly"
						type="number"
						min="0"
						step="0.01"
						bind:value={budget.monthly}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="budget-currency">{m.admin_settings_ai_currency()}</Field.Label>
					<Input
						id="budget-currency"
						name="currency"
						bind:value={budget.currency}
						placeholder="USD"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="budget-ratios">{m.admin_settings_ai_alert_ratios()}</Field.Label>
					<Input
						id="budget-ratios"
						name="alertRatios"
						bind:value={alertRatiosText}
						placeholder="0.8, 0.9, 1"
					/>
					<Field.Description>{m.admin_settings_ai_alert_ratios_desc()}</Field.Description>
				</Field.Field>
			</div>
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium">{m.admin_settings_ai_budget_pause_label()}</div>
					<div class="text-xs text-muted-foreground">
						{m.admin_settings_ai_budget_pause_hint()}
					</div>
				</div>
				<Switch
					name="pauseAutoOnExceed"
					bind:checked={budget.pauseAutoOnExceed}
					onCheckedChange={() => (dirtyForms.budget = true)}
					aria-label={m.admin_settings_ai_budget_pause()}
				/>
			</div>
			{#if data.canManage}
				<div class="flex items-center justify-end">
					<Button type="submit" size="sm">
						<IconDeviceFloppy data-icon="inline-start" />
						{m.admin_settings_ai_save_budget()}
					</Button>
				</div>
			{/if}
		</form>

		<!-- Style guide -->
		<form
			id="context"
			method="post"
			action="?/saveStyleGuide"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirtyForms.styleguide = true)}
			onchange={() => (dirtyForms.styleguide = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.styleguide = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_style()}</h3>
			<Field.Field>
				<Field.Label for="style-guide">{m.admin_settings_ai_style_label()}</Field.Label>
				<Textarea
					id="style-guide"
					name="text"
					rows={5}
					bind:value={styleGuideText}
					placeholder={m.admin_settings_ai_style_ph()}
				/>
			</Field.Field>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_style()}
				</Button>
			</div>
		</form>

		<!-- Memory cards sit beside the style guide because they are the same
		     kind of thing: context injected into a model, not a usage record. -->
		<div class="flex flex-col gap-4 rounded-lg border p-4">
			<h3 class="text-sm font-semibold">{m.admin_ai_tab_memories()}</h3>
			<p class="text-xs text-muted-foreground">{m.admin_ai_memory_pending()}</p>
			<MemoryCards memories={data.memories} memoryLimit={data.memoryLimit} />
		</div>

		<!-- Translation threshold -->
		<form
			method="post"
			action="?/saveTranslation"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirtyForms.translation = true)}
			onchange={() => (dirtyForms.translation = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.translation = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_translation()}</h3>
			<div class="grid gap-3 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="translation-min-chars">{m.admin_settings_ai_min_chars()}</Field.Label>
					<Input
						id="translation-min-chars"
						name="minChars"
						type="number"
						min="1"
						step="1"
						bind:value={translation.minChars}
					/>
					<Field.Description>{m.admin_settings_ai_min_chars_desc()}</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="translation-default-mode">
						{m.admin_settings_ai_default_mode()}
					</Field.Label>
					<Select.Root
						type="single"
						name="defaultMode"
						bind:value={translation.defaultMode as never}
					>
						<Select.Trigger id="translation-default-mode" class="w-full">
							{translation.defaultMode}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="auto">{m.admin_settings_ai_mode_auto()}</Select.Item>
							<Select.Item value="review">{m.admin_settings_ai_mode_review()}</Select.Item>
							<Select.Item value="manual">{m.admin_settings_ai_mode_manual()}</Select.Item>
						</Select.Content>
					</Select.Root>
					<Field.Description>{m.admin_settings_ai_default_mode_desc()}</Field.Description>
				</Field.Field>
			</div>
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium">{m.admin_settings_ai_notes_translate()}</div>
					<div class="text-xs text-muted-foreground">
						{m.admin_settings_ai_notes_translate_hint()}
					</div>
				</div>
				<Switch
					name="notesAuto"
					bind:checked={translation.notesAuto}
					onCheckedChange={() => (dirtyForms.translation = true)}
					aria-label={m.admin_settings_ai_notes_translate()}
				/>
			</div>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_translation()}
				</Button>
			</div>
		</form>

		<!-- Summary -->
		<form
			method="post"
			action="?/saveSummary"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirtyForms.summary = true)}
			onchange={() => (dirtyForms.summary = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.summary = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_summary()}</h3>
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium">{m.admin_settings_ai_summary_auto()}</div>
					<div class="text-xs text-muted-foreground">{m.admin_settings_ai_summary_auto_hint()}</div>
				</div>
				<Switch
					name="auto"
					bind:checked={summaryOpt.auto}
					onCheckedChange={() => (dirtyForms.summary = true)}
					aria-label={m.admin_settings_ai_summary_auto()}
				/>
			</div>
			<Field.Field class="max-w-xs">
				<Field.Label for="summary-min-chars">{m.admin_settings_ai_summary_min_chars()}</Field.Label>
				<Input
					id="summary-min-chars"
					name="minChars"
					type="number"
					min="1"
					step="1"
					bind:value={summaryOpt.minChars}
				/>
				<Field.Description>{m.admin_settings_ai_summary_min_chars_desc()}</Field.Description>
			</Field.Field>
			<div class="flex justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_summary()}
				</Button>
			</div>
		</form>

		<!-- Pricing: rows, not a JSON document -->
		<PricingCard
			pricing={data.pricing}
			known={pricingKeys}
			canManage={data.canManage}
			errors={pricingErrors}
			sync={pricingSync}
		/>

		<!-- AI crawler policy -->
		<form
			method="post"
			action="?/saveCrawl"
			class="flex flex-col gap-3 rounded-lg border p-4"
			onchange={() => (dirtyForms.crawl = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirtyForms.crawl = false;
					await update();
				}}
		>
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_crawl()}</h3>
			<p class="text-xs text-muted-foreground">{m.admin_settings_ai_crawl_hint()}</p>
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">{m.admin_settings_ai_crawl_answer()}</span>
				<Switch
					name="answerEngine"
					bind:checked={crawl.answerEngine}
					onCheckedChange={() => (dirtyForms.crawl = true)}
					aria-label={m.admin_settings_ai_crawl_answer()}
				/>
			</div>
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">{m.admin_settings_ai_crawl_training()}</span>
				<Switch
					name="training"
					bind:checked={crawl.training}
					onCheckedChange={() => (dirtyForms.crawl = true)}
					aria-label={m.admin_settings_ai_crawl_training()}
				/>
			</div>
			<div class="flex justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_crawl()}
				</Button>
			</div>
		</form>
	</section>
</div>

<!-- ── Provider dialog ──────────────────────────────────────────────── -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content bind:ref={providerDialogEl} class="sm:max-w-lg" showCloseButton={false}>
		{#if data.canManage}
			<!-- Sibling form: the refresh button inside the save form references
			     this by id, so the two never nest. The hidden fields mirror the
			     dialog, which lets discovery run on a provider that is not saved
			     yet and probes edits before they are persisted. -->
			<form
				id="provider-refresh-form"
				method="post"
				action="?/refreshModels"
				use:enhance={() => {
					refreshingModels = true;
					refreshMessage = '';
					return async ({ result, update }) => {
						refreshingModels = false;
						if (result.type === 'error') {
							refreshMessage = result.error.message;
						} else if (result.type === 'failure' || result.type === 'success') {
							refreshMessage = typeof result.data?.message === 'string' ? result.data.message : '';
						}
						if (result.type === 'success' && result.data?.discovered) {
							fieldDiscovered = result.data.discovered as AiModelEntry[];
						}
						await update({ reset: false });
					};
				}}
			>
				{#if editing}
					<input type="hidden" name="id" value={editing.id} />
				{/if}
				<input type="hidden" name="kind" value={fieldKind} />
				<input type="hidden" name="baseUrl" value={fieldBaseUrl} />
				<input type="hidden" name="apiKeyEnv" value={fieldApiKeyEnv} />
			</form>
		{/if}
		<form
			method="post"
			action="?/saveProvider"
			use:enhance={() => {
				savingProvider = true;
				return async ({ result, update }) => {
					savingProvider = false;
					if (result.type === 'success') dialogOpen = false;
					await update({ reset: false });
				};
			}}
		>
			{#if editing}
				<input type="hidden" name="id" value={editing.id} />
			{/if}
			<div class="flex items-center justify-between gap-3 border-b px-4 pb-3">
				<Dialog.Title
					>{editing
						? m.admin_settings_ai_edit_provider()
						: m.admin_settings_ai_add_provider()}</Dialog.Title
				>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							{...props}
							aria-label={m.admin_common_close()}
						>
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-4 py-4">
				<Field.Group>
					<Field.Field>
						<Field.Label for="provider-preset">{m.admin_settings_ai_preset()}</Field.Label>
						<Select.Root type="single" bind:value={fieldPreset} onValueChange={applyPreset}>
							<Select.Trigger id="provider-preset" class="w-full">
								{AI_PROVIDER_PRESETS.find((preset) => preset.id === fieldPreset)?.label ??
									m.admin_settings_ai_preset_placeholder()}
							</Select.Trigger>
							<Select.Content portalProps={providerDialogEl ? { to: providerDialogEl } : undefined}>
								{#each AI_PROVIDER_PRESETS as preset (preset.id)}
									<Select.Item value={preset.id} disabled={!preset.verified}>
										{preset.label}{#if !preset.verified}
											· {m.admin_settings_ai_preset_unverified()}{/if}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Field.Description>{m.admin_settings_ai_preset_hint()}</Field.Description>
					</Field.Field>
					<Field.Field data-invalid={providerErrors?.name ? true : undefined}>
						<Field.Label for="provider-name">
							{m.admin_settings_ai_field_name()} <span class="text-destructive">*</span>
						</Field.Label>
						<Input
							id="provider-name"
							name="name"
							bind:value={fieldName}
							required
							maxlength={80}
							aria-invalid={providerErrors?.name ? true : undefined}
						/>
						{#if providerErrors?.name}
							<Field.Error>{providerErrors.name}</Field.Error>
						{/if}
					</Field.Field>
					<Field.Field>
						<Field.Label for="provider-kind">{m.admin_settings_ai_field_kind()}</Field.Label>
						<Select.Root type="single" name="kind" bind:value={fieldKind}>
							<Select.Trigger id="provider-kind" class="w-full">
								{AI_PROVIDER_KIND_LABELS[fieldKind as keyof typeof AI_PROVIDER_KIND_LABELS]?.[
									getLocale()
								] ?? fieldKind}
							</Select.Trigger>
							<Select.Content portalProps={providerDialogEl ? { to: providerDialogEl } : undefined}>
								{#each AI_PROVIDER_KINDS as kind (kind)}
									<Select.Item value={kind}
										>{AI_PROVIDER_KIND_LABELS[kind][getLocale()]}</Select.Item
									>
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<Field.Field data-invalid={providerErrors?.baseUrl ? true : undefined}>
						<Field.Label for="provider-base-url">{m.admin_settings_ai_field_base_url()}</Field.Label
						>
						<Input
							id="provider-base-url"
							name="baseUrl"
							bind:value={fieldBaseUrl}
							placeholder={kindPlaceholder[fieldKind] ?? ''}
							aria-invalid={providerErrors?.baseUrl ? true : undefined}
						/>
						<Field.Description>{m.admin_settings_ai_kind_hint()}</Field.Description>
						{#if providerErrors?.baseUrl}
							<Field.Error>{providerErrors.baseUrl}</Field.Error>
						{/if}
					</Field.Field>
					<Field.Field data-invalid={providerErrors?.apiKeyEnv ? true : undefined}>
						<Field.Label for="provider-env">{m.admin_settings_ai_field_env()}</Field.Label>
						<Input
							id="provider-env"
							name="apiKeyEnv"
							bind:value={fieldApiKeyEnv}
							placeholder="AI_OPENAI_KEY"
							aria-invalid={providerErrors?.apiKeyEnv ? true : undefined}
						/>
						<Field.Description>
							{m.admin_settings_ai_env_hint()}
						</Field.Description>
						{#if providerErrors?.apiKeyEnv}
							<Field.Error>{providerErrors.apiKeyEnv}</Field.Error>
						{/if}
					</Field.Field>
					<Field.Field>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<Field.Label for="provider-models-search"
								>{m.admin_settings_ai_field_models()}</Field.Label
							>
							{#if data.canManage}
								<div class="flex items-center gap-2">
									<Button
										type="submit"
										form="provider-refresh-form"
										variant="outline"
										size="sm"
										disabled={savingProvider || refreshingModels}
									>
										{#if refreshingModels}
											<Spinner data-icon="inline-start" />
										{:else}
											<IconDownload data-icon="inline-start" />
										{/if}
										{m.admin_settings_ai_refresh()}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onclick={() => (manualModelOpen = !manualModelOpen)}
									>
										<IconPlus data-icon="inline-start" />
										{m.admin_settings_ai_models_manual()}
									</Button>
								</div>
							{/if}
						</div>
						<div class="overflow-hidden rounded-lg border">
							<div class="border-b p-2">
								<Input
									id="provider-models-search"
									bind:value={modelSearch}
									placeholder={m.admin_settings_ai_models_search()}
									class="h-8"
								/>
							</div>
							<ul class="max-h-56 overflow-y-auto">
								{#each filteredModels as entry (entry.id)}
									<li class="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
										<Checkbox
											class="size-3.5"
											checked={enabledInDialog.has(entry.id)}
											onCheckedChange={(checked) => toggleModel(entry.id, checked === true)}
											aria-label={entry.id}
										/>
										<span class="min-w-0 flex-1 truncate">{entry.id}</span>
										{#if enabledInDialog.has(entry.id)}
											<span class="text-xs text-muted-foreground"
												>{m.admin_settings_ai_models_enabled()}</span
											>
										{/if}
									</li>
								{/each}
								{#if !filteredModels.length}
									<li class="px-3 py-4 text-center text-xs text-muted-foreground">
										{modelSearch.trim()
											? m.admin_settings_ai_models_no_match()
											: m.admin_settings_ai_models_empty()}
									</li>
								{/if}
							</ul>
						</div>
						{#if manualModelOpen}
							<div class="flex items-center gap-2">
								<Input
									bind:value={manualModelId}
									placeholder={m.admin_settings_ai_models_manual_ph()}
									onkeydown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											addManualModel();
										}
									}}
								/>
								<Button type="button" size="sm" onclick={addManualModel}>
									{m.admin_common_add()}
								</Button>
							</div>
						{/if}
						<input type="hidden" name="models" value={fieldModels} />
						<Field.Description>{m.admin_settings_ai_models_hint()}</Field.Description>
						{#if refreshMessage}
							<p class="text-xs text-muted-foreground">{refreshMessage}</p>
						{/if}
					</Field.Field>
					<div class="flex items-center justify-between gap-4">
						<Field.Label for="provider-enabled">{m.admin_common_enable()}</Field.Label>
						<Switch
							id="provider-enabled"
							name="enabled"
							bind:checked={fieldEnabled}
							aria-label={m.admin_settings_ai_enable_provider()}
						/>
					</div>
				</Field.Group>
			</div>
			<div class="flex items-center justify-end gap-2 border-t px-4 pt-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={savingProvider}>
					{#if savingProvider}<Spinner data-icon="inline-start" />{/if}
					{m.admin_common_save()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- ── Provider key (write-only, W2.5) ─────────────────────────────── -->
<Dialog.Root
	open={keyTarget !== null}
	onOpenChange={(open) => {
		if (!open) keyTarget = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.admin_settings_ai_key_title({ name: keyTarget?.name ?? '' })}</Dialog.Title>
			<Dialog.Description>{m.admin_settings_ai_key_desc()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="post"
			action="?/saveProviderKey"
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') keyTarget = null;
					await update({ reset: true });
				}}
			class="flex flex-col gap-3"
		>
			<input type="hidden" name="id" value={keyTarget?.id ?? ''} />
			<Field.Field>
				<Field.Label for="provider-key-value">{m.admin_settings_ai_key_new()}</Field.Label>
				<Input
					id="provider-key-value"
					name="value"
					type="password"
					autocomplete="new-password"
					minlength={8}
					maxlength={4096}
					required
					placeholder={m.admin_settings_ai_key_placeholder()}
				/>
				<Field.Description>
					{#if keyTarget && data.providerKeys[keyTarget.id]?.configured}
						{m.admin_settings_ai_key_current({
							hint: data.providerKeys[keyTarget.id]?.hint ?? ''
						})}
					{:else}
						{m.admin_settings_ai_key_not_configured()}
					{/if}
				</Field.Description>
			</Field.Field>
			<Dialog.Footer>
				<Dialog.Close>
					<Button variant="outline">{m.admin_common_cancel()}</Button>
				</Dialog.Close>
				<Button type="submit">{m.admin_settings_ai_key_save()}</Button>
			</Dialog.Footer>
		</form>
		{#if keyTarget && data.providerKeys[keyTarget.id]?.configured}
			<form
				method="post"
				action="?/clearProviderKey"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') keyTarget = null;
						await update({ reset: false });
					}}
			>
				<input type="hidden" name="id" value={keyTarget.id} />
				<Button
					type="submit"
					variant="destructive"
					size="sm"
					onclick={(event) => {
						if (!confirm(m.admin_settings_ai_key_clear_confirm())) event.preventDefault();
					}}
				>
					{m.admin_settings_ai_key_clear()}
				</Button>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<!-- ── Delete confirm ───────────────────────────────────────────────── -->
<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => {
		if (!open) deleteTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_settings_ai_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_settings_ai_delete_desc({ name: deleteTarget?.name ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="post"
				action="?/deleteProvider"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') deleteTarget = null;
						await update({ reset: false });
					}}
			>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<Button type="submit" variant="destructive">{m.admin_common_delete()}</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

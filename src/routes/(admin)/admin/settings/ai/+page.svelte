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
		type AiProviderKind
	} from '$lib/utils/ai-meta';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconPlugConnected from '@tabler/icons-svelte-runes/icons/plug-connected';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
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
		} | null
	);
	const providerErrors = $derived(actionForm?.providerErrors ?? null);

	// ── Provider dialog state ────────────────────────────────────────────
	let dialogOpen = $state(false);
	let editing = $state<ProviderRow | null>(null);
	let savingProvider = $state(false);
	let fieldName = $state('');
	let fieldKind = $state<string>('openai-compatible');
	let fieldBaseUrl = $state('');
	let fieldApiKeyEnv = $state('');
	let fieldModels = $state('');
	let fieldEnabled = $state(true);
	let deleteTarget = $state<ProviderRow | null>(null);

	function openCreate() {
		editing = null;
		fieldName = '';
		fieldKind = 'openai-compatible';
		fieldBaseUrl = '';
		fieldApiKeyEnv = '';
		fieldModels = '';
		fieldEnabled = true;
		dialogOpen = true;
	}

	function openEdit(provider: ProviderRow) {
		editing = provider;
		fieldName = provider.name;
		fieldKind = provider.kind;
		fieldBaseUrl = provider.baseUrl ?? '';
		fieldApiKeyEnv = provider.apiKeyEnv ?? '';
		fieldModels = (provider.models ?? []).join('\n');
		fieldEnabled = provider.enabled;
		dialogOpen = true;
	}

	// ── Assignments / moderation / budget / style-guide state ───────────
	let assignProviders = $state<Record<string, string>>({});
	let assignModels = $state<Record<string, string>>({});
	let mod = $state(untrack(() => ({ ...data.moderation })));
	let modKeywords = $state('');
	let modRegexes = $state('');
	let modTrusted = $state('');
	let budget = $state(untrack(() => ({ ...data.budget })));
	let alertRatiosText = $state('');
	let styleGuideText = $state('');
	let translation = $state(untrack(() => ({ ...data.translation })));
	// True while one of the five block forms holds unsaved edits. The resync
	// effect below must not clobber that state when an unrelated enhance (e.g.
	// another row's "test connection") refreshes the load data (AI-2.1 review).
	let dirty = $state(false);

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
		if (dirty) return;
		const nextProviders: Record<string, string> = {};
		const nextModels: Record<string, string> = {};
		for (const fn of AI_FUNCTIONS) {
			nextProviders[fn] = freshAssignments[fn]?.provider ?? '';
			nextModels[fn] = freshAssignments[fn]?.model ?? '';
		}
		assignProviders = nextProviders;
		assignModels = nextModels;
		mod = { ...freshModeration };
		modKeywords = freshModeration.keywords.join('\n');
		modRegexes = freshModeration.regexes.join('\n');
		modTrusted = freshModeration.trustedUsers.join('\n');
		budget = { ...freshBudget };
		alertRatiosText = freshBudget.alertRatios.join(', ');
		styleGuideText = freshStyleGuide.text;
		translation = { ...freshTranslation };
	});

	const kindPlaceholder: Record<string, string> = {
		'openai-compatible': 'https://api.openai.com/v1',
		deepl: 'https://api.deepl.com/v2',
		custom: 'https://your-gateway.example.com'
	};
</script>

<svelte:head>
	<title>{m.admin_settings_ai()} - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-8">
	{#if actionForm?.message}
		<Alert.Root>
			<Alert.Title>{actionForm.message}</Alert.Title>
		</Alert.Root>
	{/if}

	<!-- ── 服务商 ─────────────────────────────────────────────────────── -->
	<section class="flex flex-col gap-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="text-base font-medium">{m.admin_settings_ai_providers()}</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.admin_settings_ai_providers_desc()}
				</p>
			</div>
			<Button type="button" variant="outline" size="sm" onclick={openCreate}>
				<IconPlus data-icon="inline-start" />
				{m.admin_settings_ai_add_provider()}
			</Button>
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
			<div class="flex flex-col gap-2">
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
								{#if provider.models?.length}
									<span>{m.admin_settings_ai_model_count({ count: provider.models.length })}</span>
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
							<Button variant="outline" size="sm" onclick={() => openEdit(provider)}>
								<IconPencil data-icon="inline-start" />
								{m.admin_common_edit()}
							</Button>
							<Button variant="destructive" size="sm" onclick={() => (deleteTarget = provider)}>
								<IconTrash data-icon="inline-start" />
								{m.admin_common_delete()}
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<Separator.Root />

	<!-- ── 功能位分配 ─────────────────────────────────────────────────── -->
	<section class="flex flex-col gap-4">
		<header>
			<h2 class="text-base font-medium">{m.admin_settings_ai_assignments()}</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				{m.admin_settings_ai_assignments_desc()}
			</p>
		</header>
		<form
			method="post"
			action="?/saveAssignments"
			class="flex flex-col gap-4"
			oninput={() => (dirty = true)}
			onchange={() => (dirty = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirty = false;
					await update();
				}}
		>
			{#each AI_FUNCTIONS as fn (fn)}
				<div class="grid items-center gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]">
					<div class="text-sm font-medium">{AI_FUNCTION_LABELS[fn][getLocale()]}</div>
					<Select.Root
						type="single"
						name={`assign_${fn}`}
						bind:value={assignProviders[fn]}
						onValueChange={() => (dirty = true)}
					>
						<Select.Trigger class="w-full">
							{assignProviders[fn] || m.admin_settings_ai_no_provider()}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content>
								<Select.Item value="">{m.admin_settings_ai_no_provider()}</Select.Item>
								{#each data.providers as p (p.id)}
									<Select.Item value={p.name}>{p.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					<Input
						name={`model_${fn}`}
						bind:value={assignModels[fn]}
						placeholder={m.admin_settings_ai_model_placeholder()}
					/>
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

	<!-- ── 开关与阈值 ─────────────────────────────────────────────────── -->
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

		<!-- 评论分诊 -->
		<form
			method="post"
			action="?/saveModeration"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirty = true)}
			onchange={() => (dirty = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirty = false;
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
						onCheckedChange={() => (dirty = true)}
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
						onCheckedChange={() => (dirty = true)}
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
						onCheckedChange={() => (dirty = true)}
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

		<!-- 预算 -->
		<form
			method="post"
			action="?/saveBudget"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirty = true)}
			onchange={() => (dirty = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirty = false;
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
					onCheckedChange={() => (dirty = true)}
					aria-label={m.admin_settings_ai_budget_pause()}
				/>
			</div>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_budget()}
				</Button>
			</div>
		</form>

		<!-- 风格指南 -->
		<form
			method="post"
			action="?/saveStyleGuide"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirty = true)}
			onchange={() => (dirty = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirty = false;
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

		<!-- 翻译门槛 -->
		<form
			method="post"
			action="?/saveTranslation"
			class="flex flex-col gap-4 rounded-lg border p-4"
			oninput={() => (dirty = true)}
			onchange={() => (dirty = true)}
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') dirty = false;
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
					onCheckedChange={() => (dirty = true)}
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
	</section>
</div>

<!-- ── Provider dialog ──────────────────────────────────────────────── -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
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
							<Select.Portal>
								<Select.Content>
									{#each AI_PROVIDER_KINDS as kind (kind)}
										<Select.Item value={kind}
											>{AI_PROVIDER_KIND_LABELS[kind][getLocale()]}</Select.Item
										>
									{/each}
								</Select.Content>
							</Select.Portal>
						</Select.Root>
					</Field.Field>
					<Field.Field data-invalid={providerErrors?.baseUrl ? true : undefined}>
						<Field.Label for="provider-base-url">Base URL</Field.Label>
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
						<Field.Label for="provider-models">{m.admin_settings_ai_field_models()}</Field.Label>
						<Textarea
							id="provider-models"
							name="models"
							rows={3}
							bind:value={fieldModels}
							placeholder={m.admin_settings_ai_models_ph()}
						/>
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

<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
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
	// True while one of the four block forms holds unsaved edits. The resync
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
	});

	const kindPlaceholder: Record<string, string> = {
		'openai-compatible': 'https://api.openai.com/v1',
		deepl: 'https://api.deepl.com/v2',
		custom: 'https://your-gateway.example.com'
	};
</script>

<svelte:head>
	<title>AI 设定 - Lair Admin</title>
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
				<h2 class="text-base font-medium">AI 服务商</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					接入各家 AI / 本地部署 / 自组网端点。密钥不落库——这里只填写环境变量名。
				</p>
			</div>
			<Button type="button" variant="outline" size="sm" onclick={openCreate}>
				<IconPlus data-icon="inline-start" />
				添加服务商
			</Button>
		</header>

		{#if actionForm?.providerTest}
			<Alert.Root variant={actionForm.providerTest.ok ? 'default' : 'destructive'}>
				<IconPlugConnected />
				<Alert.Title>连接检测 · {actionForm.providerTest.name}</Alert.Title>
				<Alert.Description>{actionForm.providerTest.message}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if data.providers.length === 0}
			<Empty.Root class="border">
				<Empty.Header>
					<Empty.Media variant="icon">
						<IconSettings />
					</Empty.Media>
					<Empty.Title>暂无服务商</Empty.Title>
					<Empty.Description>添加第一个服务商后，AI 才会在启用之时可用。</Empty.Description>
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
									>{AI_PROVIDER_KIND_LABELS[provider.kind as AiProviderKind]}</Badge
								>
								{#if provider.enabled}
									<Badge>启用</Badge>
								{:else}
									<Badge variant="outline">停用</Badge>
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
											<Badge variant="secondary">已设置</Badge>
										{:else}
											<Badge variant="destructive">未设置</Badge>
										{/if}
									</span>
								{/if}
								{#if provider.models?.length}
									<span>{provider.models.length} 个模型</span>
								{/if}
							</div>
						</div>
						<div class="flex shrink-0 flex-wrap items-center gap-2">
							<form method="post" action="?/testProvider" use:enhance>
								<input type="hidden" name="id" value={provider.id} />
								<Button type="submit" variant="outline" size="sm">
									<IconPlugConnected data-icon="inline-start" />
									测试连接
								</Button>
							</form>
							<Button variant="outline" size="sm" onclick={() => openEdit(provider)}>
								<IconPencil data-icon="inline-start" />
								编辑
							</Button>
							<Button variant="destructive" size="sm" onclick={() => (deleteTarget = provider)}>
								<IconTrash data-icon="inline-start" />
								删除
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
			<h2 class="text-base font-medium">功能位分配</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				未分配的功能位视为关闭——AI 是扩展能力，不阻塞任何主流程。
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
					<div class="text-sm font-medium">{AI_FUNCTION_LABELS[fn]}</div>
					<Select.Root
						type="single"
						name={`assign_${fn}`}
						bind:value={assignProviders[fn]}
						onValueChange={() => (dirty = true)}
					>
						<Select.Trigger class="w-full">
							{assignProviders[fn] || '不指定'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content>
								<Select.Item value="">不指定</Select.Item>
								{#each data.providers as p (p.id)}
									<Select.Item value={p.name}>{p.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					<Input
						name={`model_${fn}`}
						bind:value={assignModels[fn]}
						placeholder="使用服务商默认模型（可留空）"
					/>
				</div>
			{/each}
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					保存分配
				</Button>
			</div>
		</form>
	</section>

	<Separator.Root />

	<!-- ── 开关与阈值 ─────────────────────────────────────────────────── -->
	<section class="flex flex-col gap-6">
		<header>
			<h2 class="text-base font-medium">开关与阈值</h2>
			<p class="mt-1 text-xs text-muted-foreground">审核漏斗、预算护栏与写作风格指南。</p>
		</header>

		<Alert.Root>
			<IconInfoCircle />
			<Alert.Title>冻结默认（§3.3）</Alert.Title>
			<Alert.Description>
				翻译闸门 85 分、站点默认「先审」、摘要自动生成条件（正文 ≥100 字且无摘要）保持默认；
				每篇的翻译模式与开关随写作链（P2/P3）落位。
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
			<h3 class="text-sm font-semibold">评论分诊（审核）</h3>
			<div class="flex flex-col gap-3">
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">启用 AI 分诊</div>
						<div class="text-xs text-muted-foreground">默认关闭；影子期先观察再放权。</div>
					</div>
					<Switch
						name="enabled"
						bind:checked={mod.enabled}
						onCheckedChange={() => (dirty = true)}
						aria-label="启用 AI 分诊"
					/>
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">影子模式</div>
						<div class="text-xs text-muted-foreground">只记录不执行（applied=false）。</div>
					</div>
					<Switch
						name="shadowMode"
						bind:checked={mod.shadowMode}
						onCheckedChange={() => (dirty = true)}
						aria-label="影子模式"
					/>
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium">首评必审</div>
						<div class="text-xs text-muted-foreground">新访客的第一条评论进入人工队列。</div>
					</div>
					<Switch
						name="firstCommentHold"
						bind:checked={mod.firstCommentHold}
						onCheckedChange={() => (dirty = true)}
						aria-label="首评必审"
					/>
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field.Field>
						<Field.Label for="mod-link-threshold">链接数阈值</Field.Label>
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
						<Field.Label for="mod-allow">放行阈值</Field.Label>
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
						<Field.Label for="mod-block">拦截阈值</Field.Label>
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
					<Field.Label for="mod-keywords">关键词（每行一个）</Field.Label>
					<Textarea id="mod-keywords" name="keywords" rows={3} bind:value={modKeywords} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="mod-regexes">正则（每行一条，逐条校验）</Field.Label>
					<Textarea id="mod-regexes" name="regexes" rows={3} bind:value={modRegexes} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="mod-trusted">信任用户（每行一个用户 ID）</Field.Label>
					<Textarea id="mod-trusted" name="trustedUsers" rows={2} bind:value={modTrusted} />
				</Field.Field>
			</div>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					保存审核设置
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
			<h3 class="text-sm font-semibold">用量预算</h3>
			<div class="grid gap-3 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="budget-monthly">月度预算（0 = 不设）</Field.Label>
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
					<Field.Label for="budget-currency">货币</Field.Label>
					<Input
						id="budget-currency"
						name="currency"
						bind:value={budget.currency}
						placeholder="USD"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="budget-ratios">告警比例</Field.Label>
					<Input
						id="budget-ratios"
						name="alertRatios"
						bind:value={alertRatiosText}
						placeholder="0.8, 0.9, 1"
					/>
					<Field.Description>留空 = 默认 0.8, 0.9, 1</Field.Description>
				</Field.Field>
			</div>
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium">超限停自动、保人工</div>
					<div class="text-xs text-muted-foreground">
						达到 100% 时暂停自动任务；手动操作不受影响。
					</div>
				</div>
				<Switch
					name="pauseAutoOnExceed"
					bind:checked={budget.pauseAutoOnExceed}
					onCheckedChange={() => (dirty = true)}
					aria-label="超限停自动"
				/>
			</div>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					保存预算
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
			<h3 class="text-sm font-semibold">写作风格指南</h3>
			<Field.Field>
				<Field.Label for="style-guide">指南文本（注入写作工具与助手）</Field.Label>
				<Textarea
					id="style-guide"
					name="text"
					rows={5}
					bind:value={styleGuideText}
					placeholder="例如：语气直接，少用形容词；术语保持英文原样；正文默认 Markdown。"
				/>
			</Field.Field>
			<div class="flex items-center justify-end">
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					保存风格指南
				</Button>
			</div>
		</form>
	</section>
</div>

<!-- ── Provider dialog ──────────────────────────────────────────────── -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
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
				<Dialog.Title>{editing ? '编辑服务商' : '添加服务商'}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon" class="size-7" {...props} aria-label="关闭">
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-4 py-4">
				<Field.Group>
					<Field.Field data-invalid={providerErrors?.name ? true : undefined}>
						<Field.Label for="provider-name">
							名称 <span class="text-destructive">*</span>
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
						<Field.Label for="provider-kind">类型</Field.Label>
						<Select.Root type="single" name="kind" bind:value={fieldKind}>
							<Select.Trigger id="provider-kind" class="w-full">
								{AI_PROVIDER_KIND_LABELS[fieldKind as keyof typeof AI_PROVIDER_KIND_LABELS] ??
									fieldKind}
							</Select.Trigger>
							<Select.Portal>
								<Select.Content>
									{#each AI_PROVIDER_KINDS as kind (kind)}
										<Select.Item value={kind}>{AI_PROVIDER_KIND_LABELS[kind]}</Select.Item>
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
						<Field.Description
							>仅支持 http(s) 链接；留空使用默认端点（OpenAI / DeepL）。</Field.Description
						>
						{#if providerErrors?.baseUrl}
							<Field.Error>{providerErrors.baseUrl}</Field.Error>
						{/if}
					</Field.Field>
					<Field.Field data-invalid={providerErrors?.apiKeyEnv ? true : undefined}>
						<Field.Label for="provider-env">密钥环境变量名</Field.Label>
						<Input
							id="provider-env"
							name="apiKeyEnv"
							bind:value={fieldApiKeyEnv}
							placeholder="AI_OPENAI_KEY"
							aria-invalid={providerErrors?.apiKeyEnv ? true : undefined}
						/>
						<Field.Description>
							只填变量名（.env），需以 AI_ 开头（如
							AI_OPENAI_KEY，与本站其它密钥隔离）；值永不落库、永不经由页面传输。留空 = 不需要密钥。
						</Field.Description>
						{#if providerErrors?.apiKeyEnv}
							<Field.Error>{providerErrors.apiKeyEnv}</Field.Error>
						{/if}
					</Field.Field>
					<Field.Field>
						<Field.Label for="provider-models">模型列表</Field.Label>
						<Textarea
							id="provider-models"
							name="models"
							rows={3}
							bind:value={fieldModels}
							placeholder="每行一个模型 ID（可留空，由服务商默认）"
						/>
					</Field.Field>
					<div class="flex items-center justify-between gap-4">
						<Field.Label for="provider-enabled">启用</Field.Label>
						<Switch
							id="provider-enabled"
							name="enabled"
							bind:checked={fieldEnabled}
							aria-label="启用服务商"
						/>
					</div>
				</Field.Group>
			</div>
			<div class="flex items-center justify-end gap-2 border-t px-4 pt-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={savingProvider}>
					{#if savingProvider}<Spinner data-icon="inline-start" />{/if}
					保存
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
			<AlertDialog.Title>删除服务商</AlertDialog.Title>
			<AlertDialog.Description>
				将删除「{deleteTarget?.name ?? ''}」，并从功能位分配中移除它。此操作不可撤销。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
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
				<Button type="submit" variant="destructive">删除</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

/**
 * UI-safe AI metadata: the single source for the provider kinds, the feature
 * slots and their display labels. Server code (options-registry, ai-providers
 * service) reuses the same constants.
 *
 * No imports at all beyond types - this module is reachable from the plain-Node
 * job drain through `ai/providers.ts`, where `$lib` and `$env` do not resolve.
 */

export const AI_PROVIDER_KINDS = ['openai-compatible', 'deepl', 'custom'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

type AiLabelLang = 'en' | 'zh-cn' | 'ja';

export const AI_PROVIDER_KIND_LABELS: Record<AiProviderKind, Record<AiLabelLang, string>> = {
	'openai-compatible': { en: 'OpenAI compatible', 'zh-cn': 'OpenAI 兼容', ja: 'OpenAI 互換' },
	deepl: { en: 'DeepL', 'zh-cn': 'DeepL', ja: 'DeepL' },
	custom: { en: 'Custom', 'zh-cn': '自定义', ja: 'カスタム' }
};

/**
 * Connection presets. `verified` means an official OpenAI-compatible endpoint
 * with Bearer auth was confirmed against the vendor docs; unverified entries
 * stay visible but disabled in the picker (a wrong base URL is worse than no
 * preset). The model list is always discovered at runtime - never stored here.
 */
export interface AiProviderPreset {
	id: string;
	label: string;
	kind: AiProviderKind;
	baseUrl: string;
	apiKeyEnvHint: string;
	docsUrl: string;
	verified: boolean;
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		kind: 'openai-compatible',
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnvHint: 'AI_OPENAI_KEY',
		docsUrl: 'https://platform.openai.com/docs/api-reference',
		verified: true
	},
	{
		id: 'deepseek',
		label: 'DeepSeek',
		kind: 'openai-compatible',
		baseUrl: 'https://api.deepseek.com/v1',
		apiKeyEnvHint: 'AI_DEEPSEEK_KEY',
		docsUrl: 'https://api-docs.deepseek.com/',
		verified: true
	},
	{
		id: 'zhipu',
		label: 'Zhipu GLM',
		kind: 'openai-compatible',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		apiKeyEnvHint: 'AI_ZHIPU_KEY',
		docsUrl: 'https://open.bigmodel.cn/dev/api',
		verified: true
	},
	{
		id: 'moonshot',
		label: 'Kimi (Moonshot)',
		kind: 'openai-compatible',
		baseUrl: 'https://api.moonshot.cn/v1',
		apiKeyEnvHint: 'AI_MOONSHOT_KEY',
		docsUrl: 'https://platform.moonshot.cn/docs',
		verified: true
	},
	{
		id: 'qwen',
		label: 'Qwen (DashScope)',
		kind: 'openai-compatible',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		apiKeyEnvHint: 'AI_DASHSCOPE_KEY',
		docsUrl: 'https://help.aliyun.com/zh/model-studio/',
		verified: true
	},
	{
		id: 'volcengine',
		label: 'Volcengine Ark (CN)',
		kind: 'openai-compatible',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
		apiKeyEnvHint: 'AI_VOLCENGINE_KEY',
		docsUrl: 'https://www.volcengine.com/docs/82379',
		verified: true
	},
	{
		id: 'minimax',
		label: 'MiniMax (CN)',
		kind: 'openai-compatible',
		baseUrl: 'https://api.minimax.chat/v1',
		apiKeyEnvHint: 'AI_MINIMAX_KEY',
		docsUrl: 'https://platform.minimaxi.com/document',
		verified: true
	},
	{
		id: 'stepfun',
		label: 'StepFun',
		kind: 'openai-compatible',
		baseUrl: 'https://api.stepfun.com/v1',
		apiKeyEnvHint: 'AI_STEPFUN_KEY',
		docsUrl: 'https://platform.stepfun.com/docs',
		verified: true
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		kind: 'openai-compatible',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiKeyEnvHint: 'AI_OPENROUTER_KEY',
		docsUrl: 'https://openrouter.ai/docs',
		verified: true
	},
	{
		id: 'byteplus',
		label: 'BytePlus ModelArk (Intl)',
		kind: 'openai-compatible',
		baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
		apiKeyEnvHint: 'AI_BYTEPLUS_KEY',
		docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
		verified: false
	},
	{
		id: 'longcat',
		label: 'LongCat',
		kind: 'openai-compatible',
		baseUrl: 'https://api.longcat.chat/openai/v1',
		apiKeyEnvHint: 'AI_LONGCAT_KEY',
		docsUrl: 'https://longcat.chat/',
		verified: false
	},
	{
		id: 'mimo',
		label: 'Xiaomi MiMo',
		kind: 'openai-compatible',
		baseUrl: 'https://api.xiaomimimo.com/v1',
		apiKeyEnvHint: 'AI_MIMO_KEY',
		docsUrl: 'https://platform.xiaomimimo.com/',
		verified: false
	},
	{
		id: 'qwencloud',
		label: 'QwenCloud (Intl)',
		kind: 'openai-compatible',
		baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		apiKeyEnvHint: 'AI_QWENCLOUD_KEY',
		docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/',
		verified: false
	},
	{
		id: 'tencent',
		label: 'Tencent Hunyuan (TC3)',
		kind: 'openai-compatible',
		baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
		apiKeyEnvHint: 'AI_TENCENT_KEY',
		docsUrl: 'https://cloud.tencent.com/document/product/1729',
		verified: false
	}
];

export const AI_FUNCTIONS = [
	'summary',
	'translation',
	'translation_review',
	'comment_review',
	'chat',
	'assistant'
] as const;
export type AiFunction = (typeof AI_FUNCTIONS)[number];

/**
 * One model offered by a provider. The structured shape exists for two
 * reasons only: per-model enable/disable, and remembering what `/models`
 * discovery saw so a vanished model can be flagged instead of silently
 * deleted. Price stays in `ai.pricing` (single source of truth).
 */
export interface AiModelEntry {
	id: string;
	enabled: boolean;
	source: 'manual' | 'discovered';
	/** ISO timestamp of the last discovery that returned this id. */
	lastSeenAt?: string;
	displayName?: string;
}

/**
 * Accepts the legacy `string[]` shape (rows written before the v3 model
 * entries) and the current object shape. Malformed entries are dropped rather
 * than guessed at; a blank id is not a model.
 */
export function normalizeModelEntries(models: unknown): AiModelEntry[] {
	if (!Array.isArray(models)) return [];
	const out: AiModelEntry[] = [];
	const seen = new Set<string>();
	for (const raw of models) {
		let entry: AiModelEntry | null = null;
		if (typeof raw === 'string') {
			const id = raw.trim();
			if (id) entry = { id, enabled: true, source: 'manual' };
		} else if (raw && typeof raw === 'object') {
			const value = raw as Record<string, unknown>;
			const id = typeof value.id === 'string' ? value.id.trim() : '';
			if (id) {
				entry = {
					id,
					enabled: value.enabled !== false,
					source: value.source === 'discovered' ? 'discovered' : 'manual',
					...(typeof value.lastSeenAt === 'string' ? { lastSeenAt: value.lastSeenAt } : {}),
					...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {})
				};
			}
		}
		if (entry && !seen.has(entry.id)) {
			seen.add(entry.id);
			out.push(entry);
		}
	}
	return out;
}

/** The ids a picker may offer; assignment.model still wins over this list. */
export function enabledModelIds(models: unknown): string[] {
	return normalizeModelEntries(models)
		.filter((entry) => entry.enabled)
		.map((entry) => entry.id);
}

/**
 * Reconcile the editor's "enabled models" textarea with the stored entries.
 * Removing an id from the textarea disables it (the discovery record stays),
 * and a new id becomes a manual, enabled entry. `null` means "no entries".
 */
export function mergeModelEntries(
	existing: unknown,
	ids: readonly string[] | null
): AiModelEntry[] | null {
	const byId = new Map(normalizeModelEntries(existing).map((entry) => [entry.id, entry]));
	const wanted = new Set((ids ?? []).map((id) => id.trim()).filter(Boolean));
	for (const entry of byId.values()) entry.enabled = wanted.has(entry.id);
	for (const id of wanted) {
		if (!byId.has(id)) byId.set(id, { id, enabled: true, source: 'manual' });
	}
	return byId.size ? [...byId.values()] : null;
}

/**
 * Merge a `/models` response into the stored entries. A newly discovered id
 * starts disabled (an operator opts in); a known id only refreshes its
 * `lastSeenAt`, and an id missing from the response is never deleted.
 */
export function mergeDiscoveredModels(
	existing: unknown,
	discovered: readonly string[],
	seenAt: string
): AiModelEntry[] {
	const byId = new Map(normalizeModelEntries(existing).map((entry) => [entry.id, entry]));
	for (const id of discovered) {
		const clean = id.trim();
		if (!clean) continue;
		const previous = byId.get(clean);
		byId.set(
			clean,
			previous
				? { ...previous, lastSeenAt: seenAt }
				: { id: clean, enabled: false, source: 'discovered', lastSeenAt: seenAt }
		);
	}
	return [...byId.values()];
}

export const AI_FUNCTION_LABELS: Record<AiFunction, Record<AiLabelLang, string>> = {
	summary: { en: 'Summary', 'zh-cn': '摘要', ja: '要約' },
	translation: { en: 'Translation', 'zh-cn': '翻译', ja: '翻訳' },
	translation_review: { en: 'Translation review', 'zh-cn': '翻译审校', ja: '翻訳レビュー' },
	comment_review: { en: 'Comment triage', 'zh-cn': '评论分诊', ja: 'コメントトリアージ' },
	chat: { en: 'Chat', 'zh-cn': '管理对话', ja: 'チャット' },
	assistant: { en: 'Writing assistant', 'zh-cn': '写作助手', ja: 'ライティングアシスタント' }
};

/**
 * Readiness verdicts. The type lives here rather than in the server readiness
 * module because the settings page, the console and the editors all render the
 * same copy, and none of them can import from `src/lib/server/**`.
 */
export type AiReadinessStatus =
	| 'ready'
	| 'unassigned'
	| 'provider_missing'
	| 'provider_disabled'
	| 'missing_env'
	| 'missing_model'
	| 'not_wired';

export const AI_READINESS_STATUSES: readonly AiReadinessStatus[] = [
	'ready',
	'unassigned',
	'provider_missing',
	'provider_disabled',
	'missing_env',
	'missing_model',
	'not_wired'
];

/**
 * Split into `label` (the verdict) and `hint` (the reason) so a disabled
 * control can explain itself instead of repeating what the action would do.
 */
const READINESS_KEYS: Record<AiReadinessStatus, { label: string; hint: string }> = {
	ready: { label: 'admin_readiness_ready', hint: 'admin_readiness_hint_ready' },
	unassigned: { label: 'admin_readiness_unassigned', hint: 'admin_readiness_hint_unassigned' },
	provider_missing: {
		label: 'admin_readiness_provider_missing',
		hint: 'admin_readiness_hint_provider_missing'
	},
	provider_disabled: {
		label: 'admin_readiness_provider_disabled',
		hint: 'admin_readiness_hint_provider_disabled'
	},
	missing_env: { label: 'admin_readiness_missing_env', hint: 'admin_readiness_hint_missing_env' },
	missing_model: {
		label: 'admin_readiness_missing_model',
		hint: 'admin_readiness_hint_missing_model'
	},
	not_wired: { label: 'admin_readiness_not_wired', hint: 'admin_readiness_hint_not_wired' }
};

/** Stable copy keys for a status; callers render them, never invent strings. */
export function readinessMessageKeys(status: AiReadinessStatus): { label: string; hint: string } {
	return READINESS_KEYS[status];
}

/**
 * Rendering these keys lives in `utils/readiness-copy.ts`, not here: this
 * module is reachable from the plain-Node job graph (via `ai/providers.ts`)
 * and must never import `$lib` - the job drain loads it with no bundler.
 */

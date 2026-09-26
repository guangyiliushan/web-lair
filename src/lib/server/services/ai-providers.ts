import { z } from 'zod';
import { AI_PROVIDER_KINDS, type AiProviderKind } from '$lib/utils/ai-meta';

const envNamePattern = /^[A-Z][A-Z0-9_]*$/;

/**
 * Raw form contract for the provider dialog. The transform strips empty
 * strings to null and parses the models textarea into a clean list, so the
 * route action only persists the parsed value (ai-line plan §5.2).
 */
export const providerInputSchema = z
	.object({
		name: z.string().trim().min(1, '请填写名称').max(80, '名称过长'),
		kind: z.enum(AI_PROVIDER_KINDS),
		baseUrl: z
			.string()
			.trim()
			.max(300, 'URL 过长')
			.refine((v) => v === '' || URL.canParse(v), 'Base URL 不是合法 URL'),
		apiKeyEnv: z
			.string()
			.trim()
			.max(80, '变量名过长')
			.refine((v) => v === '' || envNamePattern.test(v), '应形如 OPENAI_API_KEY'),
		modelsText: z.string().max(2000, '模型列表过长'),
		enabled: z.boolean()
	})
	.transform((v) => ({
		name: v.name,
		kind: v.kind,
		baseUrl: v.baseUrl === '' ? null : v.baseUrl,
		apiKeyEnv: v.apiKeyEnv === '' ? null : v.apiKeyEnv,
		models: parseModelsText(v.modelsText),
		enabled: v.enabled
	}));

export type ProviderInput = z.infer<typeof providerInputSchema>;

/** Lines or commas; trimmed, de-duplicated; null when empty. */
export function parseModelsText(text: string): string[] | null {
	const models = [
		...new Set(
			text
				.split(/[\n,]/)
				.map((part) => part.trim())
				.filter(Boolean)
		)
	];
	return models.length ? models : null;
}

export function parseProviderForm(form: FormData): unknown {
	return {
		name: (form.get('name') ?? '').toString(),
		kind: (form.get('kind') ?? 'openai-compatible').toString(),
		baseUrl: (form.get('baseUrl') ?? '').toString(),
		apiKeyEnv: (form.get('apiKeyEnv') ?? '').toString(),
		modelsText: (form.get('models') ?? '').toString(),
		// bits-ui Switch renders a native checkbox named input: present = on.
		enabled: form.get('enabled') !== null
	};
}

/** Flatten zod issues into per-field messages for the dialog. */
export function providerFieldErrors(error: z.ZodError): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const issue of error.issues) {
		const key = (issue.path[0] ?? 'form').toString();
		if (!errors[key]) errors[key] = issue.message;
	}
	return errors;
}

export interface ProviderTarget {
	kind: AiProviderKind;
	baseUrl: string | null;
	apiKeyEnv: string | null;
}

export interface ProviderTestResult {
	ok: boolean;
	message: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TEST_TIMEOUT_MS = 5000;

/**
 * Lightweight connectivity check (§5.2): openai-compatible hits /models,
 * deepl hits /usage, custom hits the configured base URL. Never throws -
 * network failures and timeouts come back as `{ ok: false }` with a readable
 * message. The API key is read from the caller (env), never stored here.
 */
export async function testProviderConnection(
	provider: ProviderTarget,
	getKey: (name: string) => string | undefined,
	fetchImpl: FetchLike = fetch
): Promise<ProviderTestResult> {
	try {
		if (provider.kind === 'custom' && !provider.baseUrl) {
			return { ok: false, message: '自定义服务商需要填写 Base URL' };
		}
		const key = provider.apiKeyEnv ? getKey(provider.apiKeyEnv) : undefined;
		if (provider.kind !== 'custom' && !provider.apiKeyEnv) {
			return { ok: false, message: '未配置密钥环境变量' };
		}
		if (provider.kind !== 'custom' && !key) {
			return { ok: false, message: `环境变量 ${provider.apiKeyEnv} 未设置` };
		}

		let url: string;
		const headers: Record<string, string> = {};
		if (provider.kind === 'openai-compatible') {
			url = `${(provider.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`;
			if (key) headers.authorization = `Bearer ${key}`;
		} else if (provider.kind === 'deepl') {
			url = `${(provider.baseUrl ?? 'https://api.deepl.com/v2').replace(/\/+$/, '')}/usage`;
			if (key) headers.authorization = `DeepL-Auth-Key ${key}`;
		} else {
			url = provider.baseUrl as string;
		}

		const response = await fetchImpl(url, {
			headers,
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
		});
		return response.ok
			? { ok: true, message: `连接成功（HTTP ${response.status}）` }
			: { ok: false, message: `HTTP ${response.status}` };
	} catch (caught) {
		const name = caught instanceof Error ? caught.name : '';
		if (name === 'TimeoutError' || name === 'AbortError') {
			return { ok: false, message: '连接超时（5s）' };
		}
		const message = caught instanceof Error ? caught.message : String(caught);
		return { ok: false, message: `连接失败：${message}` };
	}
}

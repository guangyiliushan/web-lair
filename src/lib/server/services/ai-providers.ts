import { z } from 'zod';
import { AI_PROVIDER_KINDS, type AiProviderKind } from '$lib/utils/ai-meta';
import { m } from '$lib/paraglide/messages';
import { defaultBaseUrl } from '../ai/providers.ts';
import { isPrivateHost, resolvePublicAddresses } from '../security/ssrf-guard.ts';

const envNamePattern = /^AI_[A-Z0-9_]+$/;

/**
 * Raw form contract for the provider dialog. The transform strips empty
 * strings to null and parses the models textarea into a clean list, so the
 * route action only persists the parsed value (ai-line plan §5.2).
 */
export const providerInputSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1, { error: () => m.admin_settings_ai_err_name_required() })
			.max(80, { error: () => m.admin_settings_ai_err_name_too_long() }),
		kind: z.enum(AI_PROVIDER_KINDS),
		baseUrl: z
			.string()
			.trim()
			.max(300, { error: () => m.admin_settings_ai_err_url_too_long() })
			// http(s) only: the schema is the first gate against file:/javascript:
			// and other schemes (AI-2.1 review - the probe fetches this URL).
			.refine((v) => v === '' || (URL.canParse(v) && /^https?:\/\//i.test(v)), {
				error: () => m.admin_settings_ai_err_base_url_format()
			}),
		apiKeyEnv: z
			.string()
			.trim()
			.max(80, { error: () => m.admin_settings_ai_err_env_too_long() })
			// Namespaced allowlist: AI keys must live under AI_*, so the probe
			// can never be pointed at BETTER_AUTH_SECRET / POSTGRES_PASSWORD
			// and ship their values to an arbitrary endpoint (AI-2.1 review).
			.refine((v) => v === '' || envNamePattern.test(v), {
				error: () => m.admin_settings_ai_err_env_prefix()
			}),
		modelsText: z.string().max(2000, { error: () => m.admin_settings_ai_err_models_too_long() }),
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
			return { ok: false, message: m.admin_settings_ai_err_custom_base_url() };
		}
		const key = getKey(provider.apiKeyEnv ?? '');
		if (provider.kind !== 'custom' && !key) {
			return {
				ok: false,
				message: provider.apiKeyEnv
					? m.admin_settings_ai_err_env_unset({ name: provider.apiKeyEnv })
					: m.admin_settings_ai_err_env_missing()
			};
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
			? { ok: true, message: m.admin_settings_ai_test_ok({ status: response.status }) }
			: { ok: false, message: `HTTP ${response.status}` };
	} catch (caught) {
		const name = caught instanceof Error ? caught.name : '';
		if (name === 'TimeoutError' || name === 'AbortError') {
			return { ok: false, message: m.admin_settings_ai_test_timeout() };
		}
		const message = caught instanceof Error ? caught.message : String(caught);
		return { ok: false, message: m.admin_settings_ai_test_failed({ message: message }) };
	}
}

export interface ModelDiscoveryResult {
	ok: boolean;
	models: string[];
	message: string;
}

const MODELS_TIMEOUT_MS = 8000;
const MODELS_MAX_CHARS = 512 * 1024;

/**
 * Fetch `/models` for an OpenAI-compatible provider. Same SSRF posture as the
 * runtime probe: private addresses are refused unless the host is on the
 * explicit `AI_ALLOW_PRIVATE_HOSTS` allowlist (local Ollama / vLLM / LiteLLM).
 * Never throws - failures come back as `{ ok: false }` with readable copy.
 */
export async function discoverProviderModels(
	provider: ProviderTarget,
	getKey: (name: string) => string | undefined,
	options: { allowPrivateHosts?: string[]; fetchImpl?: FetchLike } = {}
): Promise<ModelDiscoveryResult> {
	if (provider.kind === 'deepl') {
		return { ok: false, models: [], message: m.admin_settings_ai_refresh_unsupported() };
	}
	if (provider.kind === 'custom' && !provider.baseUrl?.trim()) {
		return { ok: false, models: [], message: m.admin_settings_ai_err_custom_base_url() };
	}
	const base = (provider.baseUrl?.trim() || defaultBaseUrl(provider.kind)).replace(/\/+$/, '');
	let url: URL;
	try {
		url = new URL(`${base}/models`);
	} catch {
		return { ok: false, models: [], message: m.admin_settings_ai_err_base_url_format() };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, models: [], message: m.admin_settings_ai_err_base_url_format() };
	}
	const host = url.hostname.toLowerCase();
	const allow = (options.allowPrivateHosts ?? [])
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
	const privateAllowed = allow.some((entry) => host === entry || host.endsWith(`.${entry}`));
	if (isPrivateHost(host) && !privateAllowed) {
		return {
			ok: false,
			models: [],
			message: m.admin_settings_ai_private_blocked({ host })
		};
	}
	try {
		if (!privateAllowed) {
			const addresses = await resolvePublicAddresses(host);
			if (!addresses) {
				return {
					ok: false,
					models: [],
					message: m.admin_settings_ai_private_blocked({ host })
				};
			}
		}
	} catch {
		return {
			ok: false,
			models: [],
			message: m.admin_settings_ai_dns_failed({ host })
		};
	}

	const headers: Record<string, string> = {};
	const key = getKey(provider.apiKeyEnv ?? '');
	if (key) headers.authorization = `Bearer ${key}`;

	try {
		const response = await (options.fetchImpl ?? fetch)(url.toString(), {
			headers,
			signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
		});
		if (!response.ok) {
			return {
				ok: false,
				models: [],
				message: m.admin_settings_ai_test_failed({ message: `HTTP ${response.status}` })
			};
		}
		const text = await response.text();
		if (text.length > MODELS_MAX_CHARS) {
			return {
				ok: false,
				models: [],
				message: m.admin_settings_ai_test_failed({ message: 'response too large' })
			};
		}
		const parsed = JSON.parse(text) as unknown;
		const record = parsed as { data?: unknown; models?: unknown };
		const items = Array.isArray(record.data)
			? record.data
			: Array.isArray(record.models)
				? record.models
				: [];
		const ids = [
			...new Set(
				items
					.map((item) => {
						if (typeof item === 'string') return item;
						if (item && typeof item === 'object') {
							const value = item as { id?: unknown; name?: unknown; model?: unknown };
							const id = value.id ?? value.name ?? value.model;
							return typeof id === 'string' ? id : '';
						}
						return '';
					})
					.map((id) => id.trim())
					.filter(Boolean)
			)
		].sort();
		if (ids.length === 0) {
			return { ok: true, models: [], message: m.admin_settings_ai_refresh_empty() };
		}
		return {
			ok: true,
			models: ids,
			message: m.admin_settings_ai_refresh_ok({ count: ids.length })
		};
	} catch (caught) {
		const name = caught instanceof Error ? caught.name : '';
		if (name === 'TimeoutError' || name === 'AbortError') {
			return { ok: false, models: [], message: m.admin_settings_ai_test_timeout() };
		}
		return {
			ok: false,
			models: [],
			message: m.admin_settings_ai_test_failed({
				message: caught instanceof Error ? caught.message : String(caught)
			})
		};
	}
}

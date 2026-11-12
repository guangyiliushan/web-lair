import { getOption } from '../config/options-registry.ts';
import { isPrivateHost, resolvePublicAddresses } from '../security/ssrf-guard.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import { assertBudget, readBudgetState, recordBudgetAlerts } from './budget.ts';
import { AiError, isFailoverCode } from './errors.ts';
import { estimateCost } from './pricing.ts';
import { defaultBaseUrl, providerUrl, resolveProviderChain } from './providers.ts';
import { recordAiUsage } from './usage.ts';
import type { AiCallInput, AiCallResult, AiDeps, AiProviderRow, AiTrigger } from './types.ts';

const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * A streamed completion is long by nature: 8k output tokens at 40-60 tok/s
 * already takes 130-200s, so a fixed whole-call cap kills it mid-body. The
 * idle watchdog is the real bound; this cap only stops a provider that keeps
 * dripping tokens forever without ever finishing.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_MS = 30_000;

interface AdapterResult {
	text: string;
	inputTokens: number | null;
	outputTokens: number | null;
	billedChars: number | null;
	requestId: string | null;
}

type Adapter = (
	input: AiCallInput,
	provider: AiProviderRow,
	model: string,
	deps: AiDeps,
	signal: AbortSignal
) => Promise<AdapterResult>;

/**
 * SSRF guard for operator-supplied provider base URLs (the `custom` slot lets
 * an admin point the server-side key at any host). Default provider URLs are
 * known-public and skip the check; a custom base URL must parse as http(s)
 * and resolve to globally routable addresses before the key goes out.
 * Results are cached per base URL for the process lifetime; a failed check is
 * evicted so an operator fixing DNS can retry. Connection-time DNS pinning
 * (links-checker style) remains a hardening TODO - the same TOCTOU residual
 * the favicon proxy documents.
 */
const validatedBaseUrls = new Map<string, Promise<void>>();

async function assertPublicBaseUrl(
	baseUrl: string,
	getEnv: (name: string) => string | undefined
): Promise<void> {
	let pending = validatedBaseUrls.get(baseUrl);
	if (!pending) {
		pending = (async () => {
			let url: URL;
			try {
				url = new URL(baseUrl);
			} catch {
				throw new AiError('bad_request', 'Provider base URL is not a valid URL');
			}
			if (url.protocol !== 'https:' && url.protocol !== 'http:') {
				throw new AiError('bad_request', 'Provider base URL must use http or https');
			}
			const host = url.hostname.toLowerCase();
			// Explicit local-provider allowlist: private ranges stay refused for
			// every other provider (SSRF boundary), but Ollama/vLLM on localhost
			// must be usable when the operator names the host.
			const privateAllowed = (getEnv('AI_ALLOW_PRIVATE_HOSTS') ?? '')
				.split(',')
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean)
				.some((entry) => host === entry || host.endsWith(`.${entry}`));
			if (privateAllowed) return;
			if (isPrivateHost(host)) {
				throw new AiError('bad_request', 'Provider base URL points at a non-public address');
			}
			try {
				const addresses = await resolvePublicAddresses(host);
				if (!addresses) throw new Error('no public addresses');
			} catch (caught) {
				if (caught instanceof AiError) throw caught;
				throw new AiError('network', 'Provider base URL failed the public-resolution check', {
					retryable: true
				});
			}
		})();
		validatedBaseUrls.set(baseUrl, pending);
		pending.catch(() => validatedBaseUrls.delete(baseUrl));
	}
	return pending;
}

function pickRequestId(response: Response, kind: AiProviderRow['kind']): string | null {
	if (kind === 'deepl') return response.headers.get('x-trace-id');
	return response.headers.get('x-request-id') ?? response.headers.get('openai-request-id');
}

async function errorFromResponse(response: Response, provider: AiProviderRow): Promise<AiError> {
	let body = '';
	try {
		body = await response.text();
	} catch {
		// ignore - the status is still actionable
	}
	const detail = sanitizeErrorText(body);
	const status = response.status;
	if (status === 401 || status === 403) {
		return new AiError('auth', `Authentication failed (${status})`, {
			status,
			provider: provider.name
		});
	}
	if (status === 429) {
		// DeepL returns 456 for an exhausted quota; 429 is rate limiting.
		return new AiError('rate_limit', `Rate limited (${status}) ${detail}`, {
			status,
			provider: provider.name
		});
	}
	if (status === 456) {
		return new AiError('quota', `Provider quota exhausted ${detail}`, {
			status,
			provider: provider.name,
			retryable: false
		});
	}
	if (status === 400 || status === 404 || status === 422) {
		return new AiError('bad_request', `Provider rejected the request (${status}) ${detail}`, {
			status,
			provider: provider.name
		});
	}
	if (status >= 500) {
		return new AiError('network', `Provider server error (${status}) ${detail}`, {
			status,
			provider: provider.name,
			retryable: true
		});
	}
	return new AiError('bad_response', `Unexpected provider response (${status}) ${detail}`, {
		status,
		provider: provider.name
	});
}

/**
 * DeepSeek's OpenAI-compatible dialect turns chain-of-thought on by default
 * (effort `high`), and the toggle is a provider extension: sending `thinking`
 * to another OpenAI-compatible gateway is a 400. Gate it on the configured
 * host for now; the provider `dialect` column (schema batch) replaces the
 * host check with an explicit declaration.
 */
function supportsThinkingToggle(provider: AiProviderRow): boolean {
	const base = provider.baseUrl?.trim() || defaultBaseUrl(provider.kind);
	try {
		return new URL(base).hostname.toLowerCase().endsWith('deepseek.com');
	} catch {
		return false;
	}
}

interface StreamedCompletionChunk {
	choices?: Array<{
		delta?: { content?: string | Array<{ type?: string; text?: string }> };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** One SSE `data:` payload may carry text, a finish reason or the usage total. */
interface StreamAccumulator {
	text: string;
	finishReason: string | null;
	usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
}

function absorbStreamBlock(block: string, state: StreamAccumulator): void {
	for (const line of block.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') continue;
		let parsed: StreamedCompletionChunk;
		try {
			parsed = JSON.parse(data) as StreamedCompletionChunk;
		} catch {
			continue;
		}
		// `stream_options.include_usage` sends the totals in a final chunk that
		// has no choices at all.
		if (parsed.usage) state.usage = parsed.usage;
		const choice = parsed.choices?.[0];
		if (!choice) continue;
		if (choice.finish_reason) state.finishReason = choice.finish_reason;
		const raw = choice.delta?.content;
		const piece = Array.isArray(raw)
			? raw.map((part) => (part?.type === 'text' ? (part.text ?? '') : '')).join('')
			: (raw ?? '');
		if (!piece) continue;
		state.text += piece;
	}
}

/**
 * Read an OpenAI-compatible SSE completion. The accumulated text is handed to
 * `onProgress` after every delta so a caller can persist a live preview; the
 * returned value is what a non-streaming call would have produced.
 */
async function readCompletionStream(
	body: ReadableStream<Uint8Array>,
	onProgress: (text: string) => void,
	touch: () => void
): Promise<StreamAccumulator> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: StreamAccumulator = { text: '', finishReason: null, usage: undefined };
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		// Any byte proves the stream is alive; the idle watchdog is reset here
		// rather than on deltas so keepalive comments also count.
		touch();
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split('\n\n');
		buffer = blocks.pop() ?? '';
		for (const block of blocks) {
			const before = state.text;
			absorbStreamBlock(block, state);
			if (state.text !== before) onProgress(state.text);
		}
	}
	// A provider that closes without the trailing blank line still owns the
	// last block; dropping it would lose the final words of the body.
	const before = state.text;
	absorbStreamBlock(buffer, state);
	if (state.text !== before) onProgress(state.text);
	return state;
}

const openAiCompatible: Adapter = async (input, provider, model, deps, signal) => {
	const base = provider.baseUrl?.trim() || defaultBaseUrl(provider.kind);
	if (provider.baseUrl?.trim()) await assertPublicBaseUrl(base, deps.getEnv);
	if (!base) throw new AiError('no_provider', 'Provider has no base URL');
	const streaming = Boolean(input.onProgress);
	/**
	 * Idle watchdog for a stream. The outer cap is minutes; a provider that
	 * stops producing chunks must fail in seconds. The same controller also
	 * covers time-to-first-byte, because `touch()` is armed before `fetch`.
	 */
	const idle = streaming ? new AbortController() : null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	const clearIdle = (): void => {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};
	const touch = (): void => {
		if (!idle) return;
		clearIdle();
		idleTimer = setTimeout(
			() => idle.abort(new Error('ai idle timeout')),
			deps.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS
		);
		// A watchdog must never keep a one-shot drain process alive.
		(idleTimer as unknown as { unref?: () => void }).unref?.();
	};
	const requestSignal = idle ? AbortSignal.any([signal, idle.signal]) : signal;
	const body = {
		model,
		messages: [
			{ role: 'system', content: input.system },
			{ role: 'user', content: input.user }
		],
		temperature: input.temperature ?? 0.2,
		...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
		// Translation/summary do not need chain-of-thought: it multiplies
		// latency and output tokens, and thinking mode ignores `temperature`
		// (official DeepSeek docs), so the deterministic 0.1 setting only
		// takes effect once this is off.
		...(input.thinking === 'off' && supportsThinkingToggle(provider)
			? { thinking: { type: 'disabled' } }
			: {}),
		// Only a caller that asked for progress pays the SSE path; every other
		// task keeps the plain JSON request it always sent.
		...(streaming ? { stream: true, stream_options: { include_usage: true } } : {})
	};
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	const key = provider.apiKeyEnv ? deps.getEnv(provider.apiKeyEnv) : undefined;
	if (provider.apiKeyEnv && !key) {
		throw new AiError('missing_key', `Environment variable ${provider.apiKeyEnv} is not set`, {
			provider: provider.name
		});
	}
	if (key) headers.authorization = `Bearer ${key}`;
	// Time-to-first-byte counts as an idle gap; clear it once headers arrive
	// and re-arm it for the body below.
	touch();
	const response = await deps.fetch!(providerUrl({ ...provider, baseUrl: base }), {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: requestSignal,
		redirect: 'error'
	});
	clearIdle();
	if (!response.ok) throw await errorFromResponse(response, provider);
	if (streaming) {
		if (!response.body) {
			throw new AiError('bad_response', 'Provider returned no stream body', {
				provider: provider.name
			});
		}
		touch();
		try {
			const streamed = await readCompletionStream(response.body, input.onProgress!, touch);
			if (streamed.finishReason === 'length') {
				throw new AiError('invalid_output', 'Provider truncated the output at max_tokens', {
					provider: provider.name
				});
			}
			if (!streamed.text.trim()) {
				throw new AiError('bad_response', 'Provider returned an empty completion', {
					provider: provider.name
				});
			}
			return {
				text: streamed.text,
				inputTokens: streamed.usage?.prompt_tokens ?? null,
				outputTokens: streamed.usage?.completion_tokens ?? null,
				billedChars: null,
				requestId: pickRequestId(response, provider.kind)
			};
		} finally {
			clearIdle();
		}
	}
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new AiError('bad_response', 'Provider returned non-JSON', { provider: provider.name });
	}
	const payload = data as {
		choices?: Array<{
			message?: { content?: string | Array<{ type?: string; text?: string }> };
			finish_reason?: string | null;
		}>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const choice = payload.choices?.[0];
	const raw = choice?.message?.content;
	const text = Array.isArray(raw)
		? raw.map((part) => (part?.type === 'text' ? (part.text ?? '') : '')).join('')
		: (raw ?? '');
	// A `length` stop means the provider cut the answer at max_tokens. The
	// deterministic checks downstream only notice when the cut happens to
	// remove a placeholder or a heading, so a truncated body whose markers
	// all landed in the kept half would otherwise be stored as a candidate.
	if (choice?.finish_reason === 'length') {
		throw new AiError('invalid_output', 'Provider truncated the output at max_tokens', {
			provider: provider.name
		});
	}
	if (!text.trim()) {
		throw new AiError('bad_response', 'Provider returned an empty completion', {
			provider: provider.name
		});
	}
	return {
		text,
		inputTokens: payload.usage?.prompt_tokens ?? null,
		outputTokens: payload.usage?.completion_tokens ?? null,
		billedChars: null,
		requestId: pickRequestId(response, provider.kind)
	};
};

/** DeepL language tags differ from the site's BCP-47-ish tags. */
function deeplLang(lang: string): string {
	const normalized = lang.toLowerCase();
	if (normalized === 'zh-cn') return 'ZH';
	if (normalized === 'ja') return 'JA';
	return normalized.toUpperCase();
}

const deepl: Adapter = async (input, provider, model, deps, signal) => {
	if (!input.translation) {
		throw new AiError('unsupported', 'DeepL can only run translation requests', {
			provider: provider.name
		});
	}
	const base = provider.baseUrl?.trim() || defaultBaseUrl(provider.kind);
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	const key = provider.apiKeyEnv ? deps.getEnv(provider.apiKeyEnv) : undefined;
	if (!provider.apiKeyEnv) {
		throw new AiError('missing_key', 'DeepL requires an API key env variable', {
			provider: provider.name
		});
	}
	if (!key) {
		throw new AiError('missing_key', `Environment variable ${provider.apiKeyEnv} is not set`, {
			provider: provider.name
		});
	}
	headers.authorization = `DeepL-Auth-Key ${key}`;
	const response = await deps.fetch!(`${base.replace(/\/+$/, '')}/translate`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			text: [input.translation.text],
			source_lang: deeplLang(input.translation.sourceLang),
			target_lang: deeplLang(input.translation.targetLang),
			// Without this flag DeepL omits the billing count from the response.
			show_billed_characters: true
		}),
		signal,
		redirect: 'error'
	});
	if (!response.ok) throw await errorFromResponse(response, provider);
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new AiError('bad_response', 'DeepL returned non-JSON', { provider: provider.name });
	}
	const payload = data as {
		translations?: Array<{ text?: string; billed_characters?: number }>;
	};
	const text = payload.translations?.[0]?.text ?? '';
	if (!text.trim()) {
		throw new AiError('bad_response', 'DeepL returned an empty translation', {
			provider: provider.name
		});
	}
	const billed = payload.translations?.[0]?.billed_characters ?? null;
	return {
		text,
		// Character-billed providers store billed characters in input_tokens;
		// output_tokens stays null and the UI labels the unit per task.
		inputTokens: billed,
		outputTokens: null,
		billedChars: billed,
		requestId: pickRequestId(response, provider.kind)
	};
};

const ADAPTERS: Record<AiProviderRow['kind'], Adapter> = {
	'openai-compatible': openAiCompatible,
	// `custom` is the documented OpenAI-compatible extension slot (self-hosted
	// gateways). A non-OpenAI protocol needs a future provider kind + adapter.
	custom: openAiCompatible,
	deepl
};

async function adapterWithRetry(
	input: AiCallInput,
	provider: AiProviderRow,
	model: string,
	deps: AiDeps
): Promise<AdapterResult> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const maxAttempts = Math.max(1, deps.maxAttempts ?? MAX_ATTEMPTS);
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const controller = new AbortController();
		// A stream gets the long cap; its per-chunk idle watchdog lives in the
		// adapter because only the reader sees individual deltas.
		const cap = input.onProgress
			? (deps.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS)
			: (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const timer = setTimeout(() => controller.abort(new Error('ai timeout')), cap);
		try {
			return await ADAPTERS[provider.kind](input, provider, model, deps, controller.signal);
		} catch (caught) {
			lastError = caught;
			const aiError =
				caught instanceof AiError
					? caught
					: new AiError('network', sanitizeErrorText(caught), {
							provider: provider.name,
							retryable: true
						});
			if (aiError.name === 'AbortError' || /aborted|timeout/i.test(aiError.message)) {
				lastError = new AiError('timeout', 'Provider call timed out', {
					provider: provider.name,
					retryable: true
				});
			}
			if (!aiError.retryable || attempt === maxAttempts) throw lastError;
			await sleep(400 * attempt * attempt);
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastError;
}

/**
 * Single entry point for every AI call. Responsibilities:
 *  1. resolve the assignment -> an ordered chain of provider + model pairs
 *     (the assigned model on every provider that serves it, then the default
 *     pool's other models as fallbacks);
 *  2. enforce the monthly budget before spending money - once, outside the
 *     loop, so a failover cannot reset or re-charge the gate;
 *  3. try each link with timeout + bounded retries, moving to the next one only
 *     for failures another provider could actually fix (`isFailoverCode`);
 *  4. write one `ai_usage` row per real attempt, success or failure;
 *  5. return a provider-agnostic result.
 *
 * It never logs secrets. The caller owns task-specific output validation.
 */
export async function runAiCall(input: AiCallInput, deps: AiDeps): Promise<AiCallResult> {
	const started = performance.now();
	const chain = await resolveProviderChain(deps.db, input.functionSlot);
	const primary = chain[0];
	// Cost attribution travels with every ledger row (success, failure and
	// budget refusal). `manual` is the legacy switch; an explicit trigger wins.
	const actorId = input.actorId ?? null;
	const trigger: AiTrigger = input.trigger ?? (input.manual ? 'manual' : 'job');

	try {
		await assertBudget(deps.db, input.manual ?? false, deps.now?.() ?? new Date());
	} catch (caught) {
		const durationMs = Math.round(performance.now() - started);
		if (caught instanceof AiError && caught.code === 'budget') {
			await recordAiUsage(deps.db, {
				task: input.task,
				provider: primary.provider.name,
				model: primary.model,
				requestedModel: primary.primaryModel,
				actorId,
				trigger,
				inputTokens: null,
				outputTokens: null,
				costEstimate: null,
				relatedType: input.relatedType ?? null,
				relatedId: input.relatedId ?? null,
				status: 'failure',
				durationMs
			});
		}
		deps.log?.(
			'[ai] call refused task=' +
				input.task +
				' code=budget: ' +
				(caught instanceof Error ? caught.message : String(caught))
		);
		throw caught;
	}

	let result: AdapterResult | null = null;
	let answered = primary;
	for (const [index, candidate] of chain.entries()) {
		const provider = candidate.provider;
		const model = candidate.model;
		try {
			result = await adapterWithRetry(input, provider, model, {
				...deps,
				fetch: deps.fetch ?? fetch
			});
			answered = candidate;
			break;
		} catch (caught) {
			const durationMs = Math.round(performance.now() - started);
			// One row per real attempt: "how often did the chain fire" must stay
			// answerable, so a failover is never folded into the next member's row.
			await recordAiUsage(deps.db, {
				task: input.task,
				provider: provider.name,
				model,
				requestedModel: candidate.primaryModel,
				actorId,
				trigger,
				inputTokens: null,
				outputTokens: null,
				costEstimate: null,
				relatedType: input.relatedType ?? null,
				relatedId: input.relatedId ?? null,
				status: 'failure',
				durationMs
			});
			const errCode = caught instanceof AiError ? caught.code : 'unknown';
			const errStatus =
				caught instanceof AiError && caught.status != null ? String(caught.status) : 'n/a';
			deps.log?.(
				'[ai] call failed task=' +
					input.task +
					' provider=' +
					provider.name +
					' model=' +
					model +
					' code=' +
					errCode +
					' http_status=' +
					errStatus +
					': ' +
					sanitizeErrorText(caught)
			);
			// Last member, or a failure the next provider cannot fix: surface the
			// original error unchanged so job summaries keep their wording.
			const next = chain[index + 1];
			if (!next || !(caught instanceof AiError && isFailoverCode(caught.code))) throw caught;
			deps.log?.(
				'[ai] failover task=' +
					input.task +
					' from=' +
					provider.name +
					' to=' +
					next.provider.name +
					' code=' +
					errCode
			);
		}
	}
	if (!result) {
		// Unreachable: the loop either returns a result or throws on the last
		// candidate. Kept so the type narrows without a non-null assertion.
		throw new AiError('bad_response', 'Aggregation chain produced no result');
	}

	const provider = answered.provider;
	const model = answered.model;
	const pricing = await getOption('ai.pricing', deps.db);
	const entry = pricing[`${provider.name}/${model}`] ?? null;
	const cost = estimateCost({
		entry,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		billedChars: result.billedChars
	});
	const durationMs = Math.round(performance.now() - started);
	await recordAiUsage(deps.db, {
		task: input.task,
		provider: provider.name,
		model,
		requestedModel: answered.primaryModel,
		actorId,
		trigger,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		costEstimate: cost,
		relatedType: input.relatedType ?? null,
		relatedId: input.relatedId ?? null,
		status: 'success',
		durationMs
	});
	if (cost != null) {
		try {
			const state = await readBudgetState(deps.db, deps.now?.() ?? new Date());
			await recordBudgetAlerts(deps.db, state, deps.now?.() ?? new Date());
		} catch (caught) {
			console.warn(
				'[ai] budget alert check failed',
				caught instanceof Error ? caught.message : caught
			);
		}
	}
	deps.log?.(
		'[ai] call ok task=' +
			input.task +
			' provider=' +
			provider.name +
			' model=' +
			model +
			(answered.primaryModel !== answered.model ? ' fallback_from=' + answered.primaryModel : '') +
			' request_id=' +
			(result.requestId ?? 'n/a') +
			' cost=' +
			(cost == null ? 'unpriced' : String(cost))
	);
	return {
		text: result.text,
		provider: provider.name,
		providerKind: provider.kind,
		model,
		requestedModel: answered.primaryModel,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		costEstimate: cost,
		durationMs,
		requestId: result.requestId
	};
}

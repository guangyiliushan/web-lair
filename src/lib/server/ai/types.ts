import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AiFunction, AiModelEntry, AiProviderKind } from '../../utils/ai-meta.ts';

/**
 * Shared AI runtime contracts.
 *
 * This module (and the rest of `src/lib/server/ai/*.ts`) deliberately uses
 * relative `.ts` imports and never touches `$lib` or `$env`: the same code is
 * loaded by the web app (SvelteKit) and by the plain-Node job drain. Callers
 * inject the database handle and the env lookup.
 */
export type AiDb = Pick<
	PostgresJsDatabase<Record<string, never>>,
	'select' | 'insert' | 'update' | 'delete'
>;

export type AiTask =
	| 'summary'
	| 'translation'
	| 'translation_review'
	| 'comment_review'
	| 'chat'
	| 'assistant'
	| 'editor'
	| 'transcription'
	| 'other';

export type AiStatus = 'success' | 'failure';

/** Who caused a model call. Open text, not a CHECK: new callers must not need a migration. */
export type AiTrigger = 'manual' | 'job' | 'agent' | 'api';

export interface AiProviderRow {
	id: string;
	name: string;
	kind: AiProviderKind;
	baseUrl: string | null;
	apiKeyEnv: string | null;
	models: AiModelEntry[] | null;
	enabled: boolean;
}

/** Minimal shape of a resolved credential; no ciphertext reaches here. */
export interface ResolvedProviderKeyLike {
	value: string;
	source: 'db' | 'env';
}

export interface AiAssignment {
	provider?: string;
	model?: string;
}

export interface AiResolvedProvider {
	provider: AiProviderRow;
	model: string;
	assignment: AiAssignment;
}

/**
 * One link of a failover chain: a concrete provider + model pair.
 *
 * `primaryModel` is the model the slot asked for. It equals `model` on the
 * first entry of the chain and on every provider of that model; it differs when
 * the chain fell back to another model of the default pool.
 */
export interface AiCandidate {
	provider: AiProviderRow;
	model: string;
	primaryModel: string;
}

export interface AiTranslationRequest {
	text: string;
	sourceLang: string;
	targetLang: string;
}

export interface AiCallInput {
	task: AiTask;
	/** Which `ai.assignments` slot resolves the provider/model. */
	functionSlot: AiFunction;
	system: string;
	user: string;
	/** Translation adapters (DeepL) read this instead of system/user. */
	translation?: AiTranslationRequest;
	/** Audit pointer; `related_id` is uuid-typed in the ledger. */
	relatedType?: string | null;
	relatedId?: string | null;
	maxOutputTokens?: number;
	temperature?: number;
	/**
	 * Ask the adapter to turn provider-side "extended thinking" off. Only the
	 * adapters whose dialect supports the toggle act on it; translation and
	 * summary use it because chain-of-thought multiplies latency and output
	 * tokens and silently disables `temperature`.
	 */
	thinking?: 'off';
	/**
	 * Manual calls stay available when the monthly budget is exceeded; only
	 * automatic (job) calls are paused by `ai.budget.pauseAutoOnExceed`.
	 */
	manual?: boolean;
	/** Cost attribution: the admin/user who caused this call, or null for jobs. */
	actorId?: string | null;
	/** Cost attribution: manual / job / agent / api. Defaults from `manual`. */
	trigger?: AiTrigger;
	/**
	 * Ask the adapter to stream: it calls this with the whole text received so
	 * far whenever more arrives, so a long body can be previewed while it is
	 * still being generated. Only OpenAI-compatible providers can stream; the
	 * others ignore it and answer once, and a retried attempt restarts the
	 * accumulated text rather than appending to the failed one.
	 */
	onProgress?: (text: string) => void;
}

export interface AiCallResult {
	text: string;
	provider: string;
	providerKind: AiProviderKind;
	model: string;
	/** The model the slot asked for; differs from `model` on a model fallback. */
	requestedModel: string;
	inputTokens: number | null;
	outputTokens: number | null;
	costEstimate: number | null;
	durationMs: number;
	/** Provider request id (OpenAI `x-request-id`, DeepL `x-trace-id`). */
	requestId: string | null;
}

export interface AiDeps {
	db: AiDb;
	/** Provider secrets are read through this seam (web: $env, jobs: process.env). */
	getEnv: (name: string) => string | undefined;
	/**
	 * Encrypted-store read path: resolves the key for one provider at
	 * call time. The web bundle and the job drain wire
	 * `resolveProviderKey`; a test or an env-only caller may omit it, in which
	 * case `getEnv(apiKeyEnv)` is the whole answer.
	 */
	resolveKey?: (provider: AiProviderRow) => Promise<ResolvedProviderKeyLike>;
	fetch?: typeof fetch;
	now?: () => Date;
	/** Test seam for retry backoff. */
	sleep?: (ms: number) => Promise<void>;
	/** Per-call wall clock cap. */
	timeoutMs?: number;
	/**
	 * Wall clock cap for a streamed call (`onProgress` set). A stream is
	 * bounded by its idle gaps (`streamIdleMs`); this only stops a provider
	 * that keeps dripping forever.
	 */
	streamTimeoutMs?: number;
	/** Abort a streamed call after this long without a chunk (default 30s). */
	streamIdleMs?: number;
	/**
	 * Attempts per call (default 3). Callers with a long input lower this so
	 * one slow document cannot eat the whole job's timeout budget.
	 */
	maxAttempts?: number;
	/**
	 * Optional structured sink for per-call audit lines (request id, error
	 * code, http status). The web bundle and the jobs wire their own loggers;
	 * tests leave it undefined.
	 */
	log?: (message: string) => void;
}

export interface AiUsageRecord {
	task: AiTask;
	provider: string;
	model: string;
	/** Model the slot asked for (see `AiCandidate.primaryModel`). */
	requestedModel?: string | null;
	actorId: string | null;
	trigger: AiTrigger;
	inputTokens: number | null;
	outputTokens: number | null;
	costEstimate: number | null;
	relatedType: string | null;
	relatedId: string | null;
	status: AiStatus;
	durationMs: number;
	/** Audio input length for transcription calls; null for text calls. */
	audioSeconds?: number | null;
}

/**
 * The pricing option's shape; the editor's row model and helpers live in
 * `$lib/utils/pricing.ts` so the client component can import them too.
 */
export type { AiPricing, AiPricingEntry } from '../../utils/pricing.ts';

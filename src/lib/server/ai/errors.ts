/**
 * Typed AI failures. The web workbench and the job runner both map these to
 * user-facing copy / job summaries; no provider-specific status codes leak
 * past the adapter boundary.
 */
export type AiErrorCode =
	| 'no_assignment'
	| 'no_provider'
	| 'provider_disabled'
	| 'no_model'
	| 'missing_key'
	| 'unsupported'
	| 'auth'
	| 'rate_limit'
	| 'quota'
	| 'timeout'
	| 'network'
	| 'bad_request'
	| 'bad_response'
	| 'invalid_output'
	| 'budget'
	| 'model_budget';

/** Retrying the SAME provider may succeed: transient by nature. */
const RETRYABLE: ReadonlySet<AiErrorCode> = new Set(['rate_limit', 'timeout', 'network']);

/**
 * Switching to the NEXT link of the chain may succeed. A superset of
 * `RETRYABLE` on purpose: an exhausted account or a wrong key is hopeless here
 * but often fine on the next provider. Request-shaped failures
 * (`bad_request`, `bad_response`, `invalid_output`, `unsupported`) are absent -
 * retrying those elsewhere would spend money twice and hide the real bug.
 * `model_budget` is absent too: it is a deliberate stop, not a failure.
 */
const FAILOVER: ReadonlySet<AiErrorCode> = new Set([
	'rate_limit',
	'quota',
	'timeout',
	'network',
	'auth',
	'missing_key'
]);

export function isFailoverCode(code: AiErrorCode): boolean {
	return FAILOVER.has(code);
}

export class AiError extends Error {
	readonly code: AiErrorCode;
	readonly status: number | null;
	readonly retryable: boolean;
	readonly provider: string | null;

	constructor(
		code: AiErrorCode,
		message: string,
		options?: { status?: number | null; provider?: string | null; retryable?: boolean }
	) {
		super(message);
		this.name = 'AiError';
		this.code = code;
		this.status = options?.status ?? null;
		this.retryable = options?.retryable ?? RETRYABLE.has(code);
		this.provider = options?.provider ?? null;
	}
}

export function isAiError(value: unknown): value is AiError {
	return value instanceof AiError;
}

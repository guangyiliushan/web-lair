/**
 * Typed failures for the runtime secret store.
 *
 * The codes are deliberate: only `missing` may fall back to an environment
 * variable. Every other code is terminal, so a wrong master key or a missing
 * key version can never be mistaken for "try the next provider" (which would
 * silently bill another account and hide the rotation bug).
 *
 * No message may contain plaintext, ciphertext or a full key value. `hint` is
 * the display fragment (`sk-…Abcd`) and is safe to log.
 */
export type SecretFailureCode =
	'missing' | 'decrypt_failed' | 'unknown_key_version' | 'store_unavailable' | 'denied';

export class SecretError extends Error {
	readonly code: SecretFailureCode;
	readonly hint: string | null;

	constructor(code: SecretFailureCode, message: string, options?: { hint?: string | null }) {
		super(message);
		this.name = 'SecretError';
		this.code = code;
		this.hint = options?.hint ?? null;
	}
}

export function isSecretError(value: unknown): value is SecretError {
	return value instanceof SecretError;
}

/** Codes that must never fall back to another source. */
export function isTerminalSecretFailure(code: SecretFailureCode): boolean {
	return code !== 'missing';
}

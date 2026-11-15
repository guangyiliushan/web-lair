import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { resolveProviderKey, type SecretDb } from '$lib/server/secrets/resolver';
import type { AiDeps } from './types.ts';

/**
 * Web-side AI dependency bundle. The runtime itself stays plain-Node
 * importable (the job drain uses the same modules); only this wrapper reads
 * SvelteKit's dynamic env.
 *
 * `resolveKey` is the encrypted-store read path (W2.4): every call re-reads
 * `ai_provider_secrets` by primary key and falls back to the provider's
 * `api_key_env` only when no row exists. One indexed read per call is
 * negligible against the provider request, and it gives write-through
 * rotation for free on every replica.
 */
export function webAiDeps(overrides: Partial<AiDeps> = {}): AiDeps {
	return {
		db: db as unknown as AiDeps['db'],
		getEnv: (name) => env[name],
		resolveKey: (provider) =>
			resolveProviderKey(db as unknown as SecretDb, provider, {
				getEnv: (name) => env[name]
			}),
		log: (message) => console.info(message),
		...overrides
	};
}

export { runAiCall } from './client.ts';
export { generateTranslation, sourceHash } from './translate.ts';
export { generateSummary } from './summarize.ts';
export { reviewComment } from './moderate.ts';
export {
	protectMarkdown,
	restoreMarkdown,
	validateTranslation,
	plainTextLength
} from './protect.ts';
export { readBudgetState } from './budget.ts';
export type {
	AiCallInput,
	AiCallResult,
	AiDeps,
	AiPricing,
	AiProviderRow,
	AiTranslationRequest
} from './types.ts';

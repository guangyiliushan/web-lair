import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import type { AiDeps } from './types.ts';

/**
 * Web-side AI dependency bundle. The runtime itself stays plain-Node
 * importable (the job drain uses the same modules); only this wrapper reads
 * SvelteKit's dynamic env.
 */
export function webAiDeps(overrides: Partial<AiDeps> = {}): AiDeps {
	return {
		db: db as unknown as AiDeps['db'],
		getEnv: (name) => env[name],
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

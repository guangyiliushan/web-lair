import { m } from '$lib/paraglide/messages';
import { isAiError, type AiErrorCode } from './errors.ts';

/**
 * Chat failures in the operator's language.
 *
 * Both chat write paths (the SSE endpoint and the plain `?/send` action) store
 * their failure text into the transcript, so a raw provider string such as
 * `No provider assigned to "chat"` would become the only explanation the
 * screen ever offers - in English, inside a three-locale admin. Configuration
 * failures get copy that names the next step; everything else keeps the
 * wrapped provider message so real errors are still debuggable.
 *
 * `budget` is deliberately absent: chat calls pass `manual: true` to
 * `assertBudget`, so the monthly pause never refuses them.
 */
const CONFIGURATION_COPY: Partial<Record<AiErrorCode, () => string>> = {
	no_assignment: () => m.admin_ai_chat_error_unconfigured(),
	no_provider: () => m.admin_ai_chat_error_unconfigured(),
	no_model: () => m.admin_ai_chat_error_unconfigured(),
	provider_disabled: () => m.admin_ai_chat_error_provider_off(),
	missing_key: () => m.admin_ai_chat_error_missing_key(),
	unsupported: () => m.admin_ai_chat_error_not_compatible()
};

export function chatErrorMessage(caught: unknown): string {
	if (isAiError(caught)) {
		const copy = CONFIGURATION_COPY[caught.code];
		if (copy) return copy();
	}
	const message = caught instanceof Error ? caught.message : String(caught);
	return m.admin_ai_chat_error({ message });
}

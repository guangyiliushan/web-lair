import type { AiPricing, AiPricingEntry } from './types.ts';

/**
 * Cost estimation has no provider API: OpenAI returns tokens (not money) and
 * DeepL returns billed characters only when asked. The price table is an
 * operator-maintained option (`ai.pricing`), keyed by `<provider>/<model>`.
 * A missing entry yields `null` cost - never a guessed number.
 */
export function pricingKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function pricingEntry(
	pricing: AiPricing,
	provider: string,
	model: string
): AiPricingEntry | null {
	return pricing[pricingKey(provider, model)] ?? null;
}

export function estimateCost(input: {
	entry: AiPricingEntry | null;
	inputTokens: number | null;
	outputTokens: number | null;
	billedChars: number | null;
}): number | null {
	const entry = input.entry;
	if (!entry) return null;
	let total = 0;
	let priced = false;
	if (input.inputTokens != null && entry.inputPer1M != null) {
		total += (input.inputTokens / 1_000_000) * entry.inputPer1M;
		priced = true;
	}
	if (input.outputTokens != null && entry.outputPer1M != null) {
		total += (input.outputTokens / 1_000_000) * entry.outputPer1M;
		priced = true;
	}
	if (input.billedChars != null && entry.per1MChars != null) {
		total += (input.billedChars / 1_000_000) * entry.per1MChars;
		priced = true;
	}
	return priced ? Math.round(total * 1_000_000) / 1_000_000 : null;
}

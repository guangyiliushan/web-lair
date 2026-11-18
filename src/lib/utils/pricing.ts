/**
 * Pricing model, shared by the server actions and the settings component.
 *
 * This lives in `$lib/utils` (not `$lib/server/ai`) because the editor is a
 * client component: SvelteKit forbids importing `$lib/server` from the browser
 * bundle, and the row helpers are pure - no database, no env, no `.ts` import
 * graph the Node job drain has to resolve. `$lib/server/ai/types.ts` re-exports
 * the two types from here, so server code keeps its existing imports.
 */

export interface AiPricingEntry {
	/** USD per 1M input tokens (OpenAI-compatible). */
	inputPer1M?: number;
	/** USD per 1M output tokens (OpenAI-compatible). */
	outputPer1M?: number;
	/** USD per 1M billed characters (DeepL and character-billed services). */
	per1MChars?: number;
	/**
	 * Where the numbers came from. Display only: the settings editor badges a
	 * catalog price differently from one a human pinned, and the sync uses it to
	 * tell an untouched entry from an edited one. Never affects billing.
	 */
	source?: 'catalog' | 'manual';
}

/** Key format: `<provider name>/<model>`; written through the options UI. */
export type AiPricing = Record<string, AiPricingEntry>;

// Row model for the pricing editor.
//
// The stored option is keyed by `<provider>/<model>`; the UI edits one row per
// key because that is the object an operator actually reasons about ("what does
// this model cost me"). Everything here is pure so the form round-trip is
// testable without a browser: `rowsFromPricing` -> inputs -> `parsePricingForm`.

/** The three prices a row can carry, in display order. */
export const PRICE_FIELDS = ['inputPer1M', 'outputPer1M', 'per1MChars'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

/**
 * Sanity ceiling in USD per 1M units. A real price never comes close; the guard
 * exists to catch a misplaced decimal (0.15 typed as 150000) before it lands in
 * the budget ledger.
 */
export const PRICE_MAX = 10_000;
/** Prices are stored with at most this many decimals (models.dev uses 3-4). */
export const PRICE_DECIMALS = 6;

export interface PricingRow {
	key: string;
	inputPer1M?: number;
	outputPer1M?: number;
	per1MChars?: number;
	source?: 'catalog' | 'manual';
}

/**
 * Comparable price for one provider+model pair. Output tokens dominate a chat
 * completion bill and DeepL bills characters, so those are the numbers that
 * compare across models. `Infinity` means "no price entry", which sorts last
 * but must never drop the row: unpriced is not unusable.
 */
export function providerPrice(pricing: AiPricing, provider: string, model: string): number {
	const entry = pricing[`${provider}/${model}`];
	if (!entry) return Number.POSITIVE_INFINITY;
	if (entry.per1MChars != null) return entry.per1MChars;
	return entry.outputPer1M ?? entry.inputPer1M ?? Number.POSITIVE_INFINITY;
}

export function splitKey(key: string): { provider: string; model: string } | null {
	const at = key.indexOf('/');
	if (at <= 0 || at === key.length - 1) return null;
	return { provider: key.slice(0, at), model: key.slice(at + 1) };
}

export function rowKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function sortRows(rows: PricingRow[]): PricingRow[] {
	return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** Empty rows are dropped: an unpriced model has no row, not a blank one. */
export function rowsFromPricing(pricing: AiPricing): PricingRow[] {
	const rows: PricingRow[] = [];
	for (const [key, entry] of Object.entries(pricing)) {
		const row: PricingRow = { key };
		if (entry.inputPer1M != null) row.inputPer1M = entry.inputPer1M;
		if (entry.outputPer1M != null) row.outputPer1M = entry.outputPer1M;
		if (entry.per1MChars != null) row.per1MChars = entry.per1MChars;
		if (entry.source) row.source = entry.source;
		rows.push(row);
	}
	return sortRows(rows);
}

export function pricingFromRows(rows: readonly PricingRow[]): AiPricing {
	const pricing: AiPricing = {};
	for (const row of rows) {
		const value: AiPricing[string] = {};
		if (row.inputPer1M != null) value.inputPer1M = row.inputPer1M;
		if (row.outputPer1M != null) value.outputPer1M = row.outputPer1M;
		if (row.per1MChars != null) value.per1MChars = row.per1MChars;
		if (row.source) value.source = row.source;
		if (row.inputPer1M == null && row.outputPer1M == null && row.per1MChars == null) continue;
		pricing[row.key] = value;
	}
	return pricing;
}

function sameNumbers(a: AiPricing[string], b: AiPricing[string]): boolean {
	return (
		a.inputPer1M === b.inputPer1M &&
		a.outputPer1M === b.outputPer1M &&
		a.per1MChars === b.per1MChars
	);
}

/**
 * Stamp a hand-edited row as `manual` and leave an untouched one alone, so the
 * badge keeps telling the truth after a save: `catalog` means "these numbers
 * still are what models.dev said", not "this key was once synced".
 */
export function markManualEdits(next: AiPricing, current: AiPricing): AiPricing {
	const result: AiPricing = {};
	for (const [key, entry] of Object.entries(next)) {
		const before = current[key];
		const unchanged = before ? sameNumbers(before, entry) : false;
		const source = unchanged ? before.source : 'manual';
		result[key] = source ? { ...entry, source } : { ...entry };
	}
	return result;
}

/** Trimmed display value for an `<input>`: `0.15`, not `0.150000`. */
export function formatPrice(value: number | undefined): string {
	if (value == null) return '';
	// Trim trailing zeros but keep integers plain: 0.15, 1, 1.98.
	return String(Number(value.toFixed(PRICE_DECIMALS)));
}

export type ParsedPrice =
	{ kind: 'empty' } | { kind: 'value'; value: number } | { kind: 'invalid' };

/**
 * One cell of money. Accepted: blank (means "no price on this axis"), plain or
 * grouped decimals in the user's notation (`0.15`, `0,15`, `1,234.5`).
 * Rejected: anything that is not a finite, non-negative number in range.
 */
export function parsePriceText(raw: string, localeDecimalComma = true): ParsedPrice {
	const text = raw.trim();
	if (text === '') return { kind: 'empty' };
	let normalised = text.replace(/\s/g, '');
	if (localeDecimalComma && !normalised.includes('.') && /^\d+,\d+$/.test(normalised)) {
		// A lone comma is a decimal separator, not a thousands separator.
		normalised = normalised.replace(',', '.');
	} else {
		normalised = normalised.replace(/,/g, '');
	}
	if (!/^\d*\.?\d+$/.test(normalised)) return { kind: 'invalid' };
	const value = Number(normalised);
	if (!Number.isFinite(value) || value < 0 || value > PRICE_MAX) return { kind: 'invalid' };
	return { kind: 'value', value: Math.round(value * 10 ** PRICE_DECIMALS) / 10 ** PRICE_DECIMALS };
}

/** Row index -> the cell that rejected the input (`key` for the model field). */
export type PricingFormErrors = Record<number, PriceField | 'key' | 'duplicate'>;

export type ParsePricingFormResult =
	{ ok: true; pricing: AiPricing } | { ok: false; errors: PricingFormErrors };

/**
 * Rebuild the option from the submitted rows. The arrays arrive in DOM order
 * (`formData.getAll`), so index i of every array belongs to the same row.
 * Invalid input fails the WHOLE save instead of silently dropping a price: a
 * dropped price would look identical to "never priced", which is how the budget
 * quietly stops being enforceable.
 */
export function parsePricingForm(input: {
	keys: readonly string[];
	inputPer1M: readonly string[];
	outputPer1M: readonly string[];
	per1MChars: readonly string[];
	localeDecimalComma?: boolean;
}): ParsePricingFormResult {
	const errors: PricingFormErrors = {};
	const rows: PricingRow[] = [];
	const seen = new Set<string>();
	const count = input.keys.length;

	for (let index = 0; index < count; index += 1) {
		const key = (input.keys[index] ?? '').trim();
		if (!splitKey(key)) {
			errors[index] = 'key';
			continue;
		}
		if (seen.has(key)) {
			errors[index] = 'duplicate';
			continue;
		}
		seen.add(key);
		const row: PricingRow = { key };
		let priced = false;
		for (const field of PRICE_FIELDS) {
			const raw = input[field][index] ?? '';
			const parsed = parsePriceText(raw, input.localeDecimalComma ?? true);
			if (parsed.kind === 'invalid') {
				errors[index] = field;
				break;
			}
			if (parsed.kind === 'value') {
				row[field] = parsed.value;
				priced = true;
			}
		}
		// A row with every cell blank is how the operator "removes" a price while
		// keeping the model visible; it is not an error and not stored.
		if (priced && !errors[index]) rows.push(row);
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, pricing: pricingFromRows(rows) };
}

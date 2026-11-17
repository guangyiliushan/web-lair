import type { AiPricing, AiPricingEntry } from './types.ts';

/**
 * Model price catalog (models.dev), filled into `ai.pricing`: the operator
 * table stays the single source and can still pin any entry by hand.
 * Matching is deliberately conservative — the base-URL host first (it
 * identifies the vendor; a display name may be a reseller), then the catalog
 * id, and a model id only when the whole catalog agrees on one price shape.
 * Cause: two vendors charging differently means "unknown", never the cheaper
 * one. Everything is pure except `fetchPricingCatalog`, so the matching and
 * merge rules are unit-tested without the network.
 */

export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

/** Catalog prices are USD per 1M tokens, the same unit `ai.pricing` stores. */
export interface CatalogModelPrice {
	inputPer1M?: number;
	outputPer1M?: number;
}

export interface CatalogProvider {
	id: string;
	/** Host of the vendor API (`api.deepseek.com`), used for the base-URL match. */
	apiHost: string | null;
	models: Record<string, CatalogModelPrice>;
}

export type PricingCatalog = Record<string, CatalogProvider>;

function finiteNonNegative(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Lower-case host without `www.`, so `https://www.api.x.com/v1` meets `api.x.com`. */
export function hostOf(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).host.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

function toPrice(raw: unknown): CatalogModelPrice | null {
	if (!raw || typeof raw !== 'object') return null;
	const cost = (raw as { cost?: unknown }).cost;
	if (!cost || typeof cost !== 'object') return null;
	const input = finiteNonNegative((cost as { input?: unknown }).input);
	const output = finiteNonNegative((cost as { output?: unknown }).output);
	if (input == null && output == null) return null;
	const price: CatalogModelPrice = {};
	if (input != null) price.inputPer1M = input;
	if (output != null) price.outputPer1M = output;
	return price;
}

/**
 * Tolerant parse: the catalog is a third-party document, so unknown fields are
 * ignored and any provider/model without a usable price pair is dropped instead
 * of producing a half-filled entry.
 */
export function parseCatalog(raw: unknown): PricingCatalog {
	const catalog: PricingCatalog = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return catalog;
	for (const [key, node] of Object.entries(raw as Record<string, unknown>)) {
		if (!node || typeof node !== 'object') continue;
		const modelsRaw = (node as { models?: unknown }).models;
		if (!modelsRaw || typeof modelsRaw !== 'object') continue;
		const models: Record<string, CatalogModelPrice> = {};
		for (const [modelId, modelRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
			const price = toPrice(modelRaw);
			if (price) models[modelId] = price;
		}
		if (Object.keys(models).length === 0) continue;
		catalog[key] = {
			id: key,
			apiHost: hostOf((node as { api?: unknown }).api as string | undefined),
			models
		};
	}
	return catalog;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Which catalog node describes this provider, if any. */
export function matchCatalogProvider(
	provider: { name: string; baseUrl?: string | null },
	catalog: PricingCatalog
): string | null {
	const host = hostOf(provider.baseUrl);
	if (host) {
		for (const [key, node] of Object.entries(catalog)) {
			if (node.apiHost === host) return key;
		}
	}
	const byName = slug(provider.name);
	if (byName && catalog[byName]) return byName;
	// A display name's separator carries no meaning: "Deep Seek" is DeepSeek.
	const joined = slug(provider.name.replace(/\s+/g, ''));
	if (joined && catalog[joined]) return joined;
	return null;
}

function priceKey(entry: CatalogModelPrice): string {
	return `${entry.inputPer1M ?? ''}/${entry.outputPer1M ?? ''}`;
}

/**
 * A model the matched provider does not list may still be priced by the
 * catalog - but only when every vendor agrees on one price. Different prices
 * mean the answer depends on who serves the call, which this module cannot know.
 */
function uniqueCatalogPrice(model: string, catalog: PricingCatalog): CatalogModelPrice | null {
	const found: CatalogModelPrice[] = [];
	for (const node of Object.values(catalog)) {
		const price = node.models[model];
		if (price) found.push(price);
	}
	if (found.length === 0) return null;
	const distinct = new Set(found.map(priceKey));
	return distinct.size === 1 ? found[0] : null;
}

function toEntry(price: CatalogModelPrice): AiPricingEntry {
	const entry: AiPricingEntry = {};
	if (price.inputPer1M != null) entry.inputPer1M = price.inputPer1M;
	if (price.outputPer1M != null) entry.outputPer1M = price.outputPer1M;
	return entry;
}

/**
 * Prices for one provider's models, keyed exactly like `ai.pricing`
 * (`<provider name>/<model>`). Character-billed vendors (DeepL) are skipped by
 * the caller: the catalog prices tokens, and a token price must never be
 * applied to a per-character bill.
 */
export function resolveProviderPricing(input: {
	name: string;
	baseUrl?: string | null;
	models: readonly string[];
	catalog: PricingCatalog;
}): { matched: string | null; entries: Record<string, AiPricingEntry> } {
	const matched = matchCatalogProvider(input, input.catalog);
	const node = matched ? input.catalog[matched] : null;
	const entries: Record<string, AiPricingEntry> = {};
	for (const model of input.models) {
		const price = node?.models[model] ?? uniqueCatalogPrice(model, input.catalog);
		if (!price) continue;
		entries[`${input.name}/${model}`] = toEntry(price);
	}
	return { matched, entries };
}

/**
 * Fill (or refresh) the operator table. Without `overwrite` a hand-pinned entry
 * always wins; with it, the catalog replaces entries it resolved and leaves
 * everything it could not resolve untouched. The key lists let the UI show the
 * diff before anything is written.
 */
export function mergePricing(input: {
	current: AiPricing;
	synced: Record<string, AiPricingEntry>;
	overwrite: boolean;
}): {
	pricing: AiPricing;
	added: number;
	updated: number;
	kept: number;
	addedKeys: string[];
	updatedKeys: string[];
	keptKeys: string[];
	/** Entries that exist but disagree with the catalog, written or not. */
	changedKeys: string[];
} {
	const pricing: AiPricing = { ...input.current };
	const addedKeys: string[] = [];
	const updatedKeys: string[] = [];
	const keptKeys: string[] = [];
	const changedKeys: string[] = [];
	for (const [key, entry] of Object.entries(input.synced)) {
		const existing = pricing[key];
		if (!existing) {
			pricing[key] = { ...entry, source: 'catalog' };
			addedKeys.push(key);
			continue;
		}
		const changed =
			existing.inputPer1M !== entry.inputPer1M ||
			existing.outputPer1M !== entry.outputPer1M ||
			existing.per1MChars !== entry.per1MChars;
		if (!changed) {
			keptKeys.push(key);
			continue;
		}
		changedKeys.push(key);
		if (input.overwrite) {
			pricing[key] = { ...entry, source: 'catalog' };
			updatedKeys.push(key);
		} else {
			keptKeys.push(key);
		}
	}
	return {
		pricing,
		added: addedKeys.length,
		updated: updatedKeys.length,
		kept: keptKeys.length,
		addedKeys,
		updatedKeys,
		keptKeys,
		changedKeys
	};
}

/**
 * The document is ~6 MB and both the preview and the confirm step need it, so
 * one successful fetch is reused for a short while. Only a success is cached:
 * a failed fetch must be retried by the next click.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; catalog: PricingCatalog } | null = null;

/** Test hook: forget the cached catalog. */
export function clearPricingCatalogCache(): void {
	cache = null;
}

export async function fetchPricingCatalog(
	options: {
		fetchImpl?: typeof fetch;
		url?: string;
		timeoutMs?: number;
		/** 0 disables the cache (tests, a forced refresh). */
		maxAgeMs?: number;
	} = {}
): Promise<PricingCatalog> {
	const maxAgeMs = options.maxAgeMs ?? CACHE_TTL_MS;
	// An injected fetch means a test double: never serve it from (or write it to)
	// the shared cache.
	const cacheable = !options.fetchImpl && !options.url;
	if (cacheable && cache && Date.now() - cache.at < maxAgeMs) return cache.catalog;

	const fetchImpl = options.fetchImpl ?? fetch;
	const url = options.url ?? DEFAULT_CATALOG_URL;
	// The document is ~6 MB: a cold TLS handshake on a slow link outlives a
	// "reasonable" 10s, and the operator is waiting on an explicit click.
	const response = await fetchImpl(url, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(options.timeoutMs ?? 25_000)
	});
	if (!response.ok) throw new Error(`catalog responded ${response.status}`);
	const catalog = parseCatalog(await response.json());
	if (Object.keys(catalog).length === 0) throw new Error('catalog is empty');
	if (cacheable) cache = { at: Date.now(), catalog };
	return catalog;
}

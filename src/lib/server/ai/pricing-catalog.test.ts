import { describe, expect, it, vi } from 'vitest';
import {
	fetchPricingCatalog,
	hostOf,
	matchCatalogProvider,
	mergePricing,
	parseCatalog,
	resolveProviderPricing
} from './pricing-catalog';

/**
 * The price sync runs against a third-party document and writes a money table,
 * so the rules are pinned here: tolerate the document, match a provider by what
 * actually identifies the vendor, never invent a price when vendors disagree,
 * and never clobber a hand-pinned entry unless asked.
 */

const catalog = parseCatalog({
	deepseek: {
		id: 'deepseek',
		api: 'https://api.deepseek.com',
		models: {
			'deepseek-flash': { id: 'deepseek-flash', cost: { input: 0.15, output: 0.6 } },
			'deepseek-pro': { id: 'deepseek-pro', cost: { input: 1, output: 2 } }
		}
	},
	openai: {
		id: 'openai',
		api: 'https://api.openai.com/v1',
		models: {
			'gpt-cheap': { cost: { input: 0.1, output: 0.2 } },
			// Two vendors charge differently for this id: ambiguous on purpose.
			'shared-model': { cost: { input: 5, output: 9 } }
		}
	},
	proxy: {
		id: 'proxy',
		api: 'https://proxy.example.com',
		models: { 'shared-model': { cost: { input: 1, output: 1 } } }
	},
	broken: {
		id: 'broken',
		models: { 'no-price': { id: 'no-price' } }
	}
});

describe('parseCatalog', () => {
	it('keeps only models with a usable price pair', () => {
		expect(Object.keys(catalog.broken ?? {})).toHaveLength(0);
		expect(catalog.deepseek?.models['deepseek-flash']).toEqual({
			inputPer1M: 0.15,
			outputPer1M: 0.6
		});
	});

	it('survives a document that is not the expected shape', () => {
		expect(parseCatalog(null)).toEqual({});
		expect(parseCatalog('nope')).toEqual({});
		expect(parseCatalog({ p: { models: 'not-an-object' } })).toEqual({});
	});
});

describe('hostOf', () => {
	it('normalises protocol, port-free path and www', () => {
		expect(hostOf('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
		expect(hostOf('https://www.api.deepseek.com/v1')).toBe('api.deepseek.com');
		expect(hostOf('not a url')).toBeNull();
		expect(hostOf(null)).toBeNull();
	});
});

describe('matchCatalogProvider', () => {
	it('prefers the base URL host over the display name', () => {
		expect(
			matchCatalogProvider(
				{ name: 'My DeepSeek key', baseUrl: 'https://api.deepseek.com/v1' },
				catalog
			)
		).toBe('deepseek');
	});

	it('falls back to a slugged provider name', () => {
		expect(matchCatalogProvider({ name: 'Deep Seek', baseUrl: null }, catalog)).toBe('deepseek');
	});

	it('returns null when nothing identifies the vendor', () => {
		expect(matchCatalogProvider({ name: 'Local llama', baseUrl: null }, catalog)).toBeNull();
	});
});

describe('resolveProviderPricing', () => {
	it('prices the models of the matched provider under our key format', () => {
		const { matched, entries } = resolveProviderPricing({
			name: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com/v1',
			models: ['deepseek-flash', 'deepseek-pro', 'unknown-model'],
			catalog
		});
		expect(matched).toBe('deepseek');
		expect(entries).toEqual({
			'DeepSeek/deepseek-flash': { inputPer1M: 0.15, outputPer1M: 0.6 },
			'DeepSeek/deepseek-pro': { inputPer1M: 1, outputPer1M: 2 }
		});
	});

	it('prices a model the vendor node lacks only when the whole catalog agrees', () => {
		const { entries } = resolveProviderPricing({
			name: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com/v1',
			models: ['gpt-cheap', 'shared-model'],
			catalog
		});
		// gpt-cheap is listed by exactly one vendor; shared-model is not ambiguous-free.
		expect(entries).toEqual({ 'DeepSeek/gpt-cheap': { inputPer1M: 0.1, outputPer1M: 0.2 } });
	});

	it('falls back to the global lookup when the vendor is unknown', () => {
		const { matched, entries } = resolveProviderPricing({
			name: 'Reseller',
			baseUrl: 'https://resell.example.net/v1',
			models: ['deepseek-flash'],
			catalog
		});
		expect(matched).toBeNull();
		expect(entries).toEqual({ 'Reseller/deepseek-flash': { inputPer1M: 0.15, outputPer1M: 0.6 } });
	});
});

describe('mergePricing', () => {
	const synced = {
		'a/x': { inputPer1M: 1, outputPer1M: 2 }
	};

	it('adds missing entries and keeps hand-pinned ones by default', () => {
		const result = mergePricing({
			current: { 'a/x': { inputPer1M: 9, outputPer1M: 9 } },
			synced,
			overwrite: false
		});
		expect(result.pricing).toEqual({ 'a/x': { inputPer1M: 9, outputPer1M: 9 } });
		expect(result).toMatchObject({ added: 0, updated: 0, kept: 1 });
	});

	it('fills what is missing', () => {
		const result = mergePricing({ current: {}, synced, overwrite: false });
		// Catalog-written entries are stamped so the editor can badge them.
		expect(result.pricing).toEqual({ 'a/x': { inputPer1M: 1, outputPer1M: 2, source: 'catalog' } });
		expect(result).toMatchObject({ added: 1, updated: 0, kept: 0 });
	});

	it('replaces only the entries the catalog resolved when overwrite is on', () => {
		const result = mergePricing({
			current: { 'a/x': { inputPer1M: 9 }, 'b/y': { per1MChars: 20 } },
			synced,
			overwrite: true
		});
		expect(result.pricing).toEqual({
			'a/x': { inputPer1M: 1, outputPer1M: 2, source: 'catalog' },
			'b/y': { per1MChars: 20 }
		});
		expect(result).toMatchObject({ added: 0, updated: 1, kept: 0, changedKeys: ['a/x'] });
	});

	it('leaves an entry alone when the catalog agrees with it', () => {
		const result = mergePricing({
			current: { 'a/x': { inputPer1M: 1, outputPer1M: 2 } },
			synced,
			overwrite: true
		});
		expect(result).toMatchObject({ updated: 0, kept: 1 });
	});
});

describe('fetchPricingCatalog', () => {
	it('parses a successful response', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ deepseek: { models: { m: { cost: { input: 1 } } } } })
		);
		const result = await fetchPricingCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(result.deepseek?.models.m).toEqual({ inputPer1M: 1 });
	});

	it('throws on a non-OK response so the caller can report it', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
		await expect(
			fetchPricingCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
		).rejects.toThrow('catalog responded 503');
	});

	it('throws when the document has no usable price at all', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ nothing: {} }));
		await expect(
			fetchPricingCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch })
		).rejects.toThrow('catalog is empty');
	});
});

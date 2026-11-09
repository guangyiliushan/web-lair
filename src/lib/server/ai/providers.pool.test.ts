import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { aiModelPool } from '../db/ai/ai-model-pool.schema.ts';
import { aiProviders } from '../db/ai/ai-provider.schema.ts';

/**
 * `resolveProviderChain` is the runtime's single decision point, and it is now
 * model-first: the assigned model runs on every enabled provider that offers it
 * (cheapest first), then the pool's other models take over in order. Those
 * rules are pinned here; the database is a chainable stub because the function
 * only issues selects.
 */

const state = vi.hoisted(() => ({
	assignments: {} as Record<string, { provider?: string; model?: string }>,
	pool: [] as { model: string; enabled: boolean; monthlyBudget: string }[],
	providers: [] as Record<string, unknown>[],
	usage: [] as { model: string; spent: string }[],
	pricing: {} as Record<string, { inputPer1M?: number; outputPer1M?: number; per1MChars?: number }>
}));

vi.mock('../config/options-registry.ts', () => ({
	getOption: async (key: string) => {
		if (key === 'ai.pricing') return state.pricing;
		return state.assignments;
	}
}));

function tableRows(name: string): unknown[] {
	if (name === getTableName(aiModelPool)) return state.pool;
	if (name === getTableName(aiProviders)) return state.providers;
	return state.usage;
}

function chainable(rows: unknown[], table?: string) {
	const query = {
		from: (source: Parameters<typeof getTableName>[0]) => {
			const name = getTableName(source);
			return chainable(tableRows(name), name);
		},
		// The only predicate the module issues is `enabled = true`, applied to
		// the provider table; the stub mirrors it so the query and the code are
		// not tested as the same thing.
		where: () =>
			chainable(
				table === getTableName(aiProviders)
					? rows.filter((row) => (row as { enabled?: boolean }).enabled !== false)
					: rows,
				table
			),
		orderBy: () => Promise.resolve(rows),
		groupBy: () => Promise.resolve(rows),
		limit: () => Promise.resolve(rows),
		then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(rows).then(resolve, reject)
	};
	return query;
}

const db = { select: () => chainable([]) } as never;

const { resolveProviderChain, providersForModel, poolEntries } = await import('./providers.ts');

function provider(name: string, overrides: Record<string, unknown> = {}) {
	return {
		id: name,
		name,
		kind: 'openai-compatible',
		baseUrl: `https://${name}.example/v1`,
		apiKeyEnv: `AI_${name.toUpperCase()}_KEY`,
		models: [{ id: 'shared', enabled: true, source: 'manual' }],
		enabled: true,
		...overrides
	};
}

beforeEach(() => {
	state.assignments = { translation: { model: 'shared' } };
	state.pool = [];
	state.providers = [];
	state.usage = [];
	state.pricing = {};
});

describe('resolveProviderChain - one model, many providers', () => {
	it('tries every enabled provider that offers the model', async () => {
		state.providers = [provider('kimi'), provider('gateway')];
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.provider.name)).toEqual(['gateway', 'kimi']);
		expect(chain.every((entry) => entry.model === 'shared')).toBe(true);
		expect(chain.every((entry) => entry.primaryModel === 'shared')).toBe(true);
	});

	it('orders providers by output price, unpriced last', async () => {
		state.providers = [provider('cheap'), provider('pricey'), provider('unknown')];
		state.pricing = {
			'cheap/shared': { outputPer1M: 0.5 },
			'pricey/shared': { outputPer1M: 9 }
		};
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.provider.name)).toEqual(['cheap', 'pricey', 'unknown']);
	});

	it('skips a provider that disabled the model or is switched off', async () => {
		state.providers = [
			provider('disabled-model', {
				models: [{ id: 'shared', enabled: false, source: 'manual' }]
			}),
			provider('disabled-provider', { enabled: false }),
			provider('ok')
		];
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.provider.name)).toEqual(['ok']);
	});

	it('keeps a legacy provider pin in front', async () => {
		state.assignments = { translation: { provider: 'kimi' } };
		state.providers = [provider('kimi'), provider('aaa')];
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.provider.name)).toEqual(['kimi', 'aaa']);
	});
});

describe('resolveProviderChain - model fallbacks', () => {
	it('appends the pool models in order after the assigned one', async () => {
		state.assignments = { translation: { model: 'backup' } };
		state.pool = [
			{ model: 'primary', enabled: true, monthlyBudget: '0' },
			{ model: 'backup', enabled: true, monthlyBudget: '0' }
		];
		state.providers = [
			provider('p', { models: [{ id: 'primary', enabled: true, source: 'manual' }] }),
			provider('b', { models: [{ id: 'backup', enabled: true, source: 'manual' }] })
		];
		const chain = await resolveProviderChain(db, 'translation');
		// The assigned model leads even though it sits second in the pool.
		expect(chain.map((entry) => `${entry.provider.name}:${entry.model}`)).toEqual([
			'b:backup',
			'p:primary'
		]);
		expect(chain[1].primaryModel).toBe('backup');
	});

	it('skips a pool model over its monthly cap', async () => {
		state.pool = [
			{ model: 'primary', enabled: true, monthlyBudget: '0' },
			{ model: 'shared', enabled: true, monthlyBudget: '1.00' }
		];
		state.usage = [{ model: 'shared', spent: '1.50' }];
		state.providers = [
			provider('p', { models: [{ id: 'primary', enabled: true, source: 'manual' }] }),
			provider('s')
		];
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.model)).toEqual(['primary']);
	});

	it('reports model_budget when every candidate is capped', async () => {
		state.pool = [{ model: 'shared', enabled: true, monthlyBudget: '1.00' }];
		state.usage = [{ model: 'shared', spent: '2.00' }];
		state.providers = [provider('s')];
		await expect(resolveProviderChain(db, 'translation')).rejects.toMatchObject({
			code: 'model_budget'
		});
	});

	it('reports no_model when nothing offers the assigned model', async () => {
		state.providers = [
			provider('p', { models: [{ id: 'other', enabled: true, source: 'manual' }] })
		];
		await expect(resolveProviderChain(db, 'translation')).rejects.toMatchObject({
			code: 'no_model'
		});
	});

	it('still refuses an unassigned slot', async () => {
		state.assignments = {};
		await expect(resolveProviderChain(db, 'translation')).rejects.toMatchObject({
			code: 'no_assignment'
		});
	});
});

describe('resolveProviderChain - following the pool', () => {
	it('runs the pool from the top when the slot names nothing', async () => {
		state.assignments = { translation: {} };
		state.pool = [
			{ model: 'first', enabled: true, monthlyBudget: '0' },
			{ model: 'second', enabled: true, monthlyBudget: '0' }
		];
		state.providers = [
			provider('p', {
				models: [
					{ id: 'first', enabled: true, source: 'manual' },
					{ id: 'second', enabled: true, source: 'manual' }
				]
			})
		];
		const chain = await resolveProviderChain(db, 'translation');
		expect(chain.map((entry) => entry.model)).toEqual(['first', 'second']);
		// Nothing was named, so every link reports its own model as the request.
		expect(chain.map((entry) => entry.primaryModel)).toEqual(['first', 'second']);
	});

	it('reports no_model when the pool it follows is empty', async () => {
		state.assignments = { translation: {} };
		state.providers = [provider('p')];
		await expect(resolveProviderChain(db, 'translation')).rejects.toMatchObject({
			code: 'no_model'
		});
	});
});

describe('providersForModel', () => {
	it('never returns DeepL for a model it does not list, and ignores unknown kinds', async () => {
		state.providers = [
			provider('deepl', {
				kind: 'deepl',
				models: [{ id: 'quality', enabled: true, source: 'manual' }]
			}),
			provider('weird', { kind: 'nope' }),
			provider('ok')
		];
		const names = (await providersForModel(db, 'shared')).map((entry) => entry.name);
		expect(names).toEqual(['ok']);
	});
});

describe('poolEntries', () => {
	it('attaches month-to-date spend per model', async () => {
		state.pool = [
			{ model: 'a', enabled: true, monthlyBudget: '2.00' },
			{ model: 'b', enabled: false, monthlyBudget: '0' }
		];
		state.usage = [{ model: 'a', spent: '0.25' }];
		const entries = await poolEntries(db);
		expect(entries).toEqual([
			{ model: 'a', enabled: true, monthlyBudget: 2, spent: 0.25 },
			{ model: 'b', enabled: false, monthlyBudget: 0, spent: 0 }
		]);
	});
});

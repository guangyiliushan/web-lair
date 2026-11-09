import { describe, expect, it } from 'vitest';
import {
	addableModels,
	assignableModels,
	budgetLabel,
	isPoolRowBlocked,
	money,
	orderedPool,
	orphanedPoolModels,
	providerBulk,
	usableProviders,
	type PoolRowView
} from './ai-pool';

function row(overrides: Partial<PoolRowView> = {}): PoolRowView {
	return {
		id: 'r1',
		model: 'shared',
		position: 0,
		enabled: true,
		monthlyBudget: 0,
		spent: 0,
		providers: [{ name: 'kimi', readiness: 'ready', envName: null }],
		...overrides
	};
}

describe('isPoolRowBlocked', () => {
	it('blocks a switched-off row and an over-budget row', () => {
		expect(isPoolRowBlocked(row())).toBe(false);
		expect(isPoolRowBlocked(row({ enabled: false }))).toBe(true);
		expect(isPoolRowBlocked(row({ monthlyBudget: 1, spent: 1 }))).toBe(true);
		// 0 means "no cap", so any spend is fine.
		expect(isPoolRowBlocked(row({ monthlyBudget: 0, spent: 99 }))).toBe(false);
	});
});

describe('usableProviders', () => {
	it('keeps only providers the runtime could call', () => {
		const entry = row({
			providers: [
				{ name: 'a', readiness: 'ready', envName: null },
				{ name: 'b', readiness: 'missing_env', envName: 'AI_B_KEY' },
				{ name: 'c', readiness: 'ready', envName: null }
			]
		});
		expect(usableProviders(entry).map((provider) => provider.name)).toEqual(['a', 'c']);
	});
});

describe('budgetLabel', () => {
	it('shows the cap or a dash', () => {
		expect(budgetLabel(row({ spent: 0.5, monthlyBudget: 2 }))).toBe('0.50 / 2.00');
		expect(budgetLabel(row({ spent: 0.5 }))).toBe('0.50 / —');
	});
});

describe('money', () => {
	it('keeps sub-cent spend visible instead of rounding it to zero', () => {
		expect(money(0)).toBe('0.00');
		expect(money(1.239)).toBe('1.24');
		// A cent is a cent.
		expect(money(0.0123)).toBe('0.01');
		// Below a cent, four digits; below that, an explicit "not zero".
		expect(money(0.0042)).toBe('0.0042');
		expect(money(0.000024)).toBe('<0.0001');
	});
});

describe('addableModels', () => {
	it('lists enabled models not in the pool, with the providers offering them', () => {
		const providers = [
			{ name: 'kimi', models: [{ id: 'a', enabled: true, source: 'manual' as const }] },
			{
				name: 'gateway',
				models: [
					{ id: 'a', enabled: true, source: 'manual' as const },
					{ id: 'b', enabled: true, source: 'manual' as const },
					{ id: 'off', enabled: false, source: 'manual' as const }
				]
			}
		];
		expect(addableModels(providers, [{ model: 'b' }])).toEqual([
			{ model: 'a', providers: ['gateway', 'kimi'] }
		]);
	});

	it('never offers a model that only exists disabled', () => {
		const providers = [
			{ name: 'kimi', models: [{ id: 'off', enabled: false, source: 'manual' as const }] }
		];
		expect(addableModels(providers, [])).toEqual([]);
	});
});

describe('assignableModels', () => {
	it('dedupes enabled models across providers', () => {
		const providers = [
			{ name: 'kimi', models: [{ id: 'b', enabled: true, source: 'manual' as const }] },
			{
				name: 'gateway',
				models: [
					{ id: 'a', enabled: true, source: 'manual' as const },
					{ id: 'b', enabled: true, source: 'manual' as const }
				]
			}
		];
		expect(assignableModels(providers)).toEqual(['a', 'b']);
	});
});

describe('orderedPool', () => {
	it('sorts by position without mutating the input', () => {
		const input = [{ position: 2 }, { position: 0 }, { position: 1 }];
		expect(orderedPool(input).map((entry) => entry.position)).toEqual([0, 1, 2]);
		expect(input.map((entry) => entry.position)).toEqual([2, 0, 1]);
	});
});

describe('providerBulk', () => {
	const providers = [
		{ name: 'kimi', models: [{ id: 'a', enabled: true, source: 'manual' as const }] },
		{
			name: 'gateway',
			models: [
				{ id: 'a', enabled: true, source: 'manual' as const },
				{ id: 'b', enabled: true, source: 'manual' as const }
			]
		}
	];
	const pool = [
		row({ id: 'r1', model: 'a', providers: [{ name: 'kimi', readiness: 'ready', envName: null }] }),
		row({
			id: 'r2',
			model: 'b',
			providers: [{ name: 'gateway', readiness: 'ready', envName: null }]
		})
	];

	it('lists what each provider can add and what it currently owns', () => {
		expect(providerBulk(providers, pool)).toEqual([
			{ name: 'gateway', addable: [], removable: ['b'] },
			{ name: 'kimi', addable: [], removable: ['a'] }
		]);
	});

	it('offers a provider whose models are all still addable', () => {
		expect(providerBulk(providers, [])).toEqual([
			{ name: 'gateway', addable: ['a', 'b'], removable: [] },
			{ name: 'kimi', addable: ['a'], removable: [] }
		]);
	});

	it('skips providers with nothing to do', () => {
		const onlyKimi = [
			{ name: 'kimi', models: [{ id: 'a', enabled: true, source: 'manual' as const }] }
		];
		expect(providerBulk(onlyKimi, pool).map((entry) => entry.name)).toEqual(['kimi']);
	});
});

describe('orphanedPoolModels', () => {
	it('names pooled models no provider lists any more', () => {
		expect(
			orphanedPoolModels(
				['a', 'gone'],
				[{ models: [{ id: 'a', enabled: true, source: 'manual' }] }]
			)
		).toEqual(['gone']);
	});

	it('keeps a model whose only provider merely disabled it', () => {
		// Disabling is reversible: the pool entry's order and budget must survive.
		expect(
			orphanedPoolModels(['a'], [{ models: [{ id: 'a', enabled: false, source: 'manual' }] }])
		).toEqual([]);
	});

	it('drops everything when no provider is left', () => {
		expect(orphanedPoolModels(['a', 'b'], [])).toEqual(['a', 'b']);
	});
});

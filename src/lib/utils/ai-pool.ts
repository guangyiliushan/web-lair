import type { AiModelEntry, AiReadinessStatus } from './ai-meta';
import { enabledModelIds } from './ai-meta';

/**
 * View contracts for the default-pool card, kept out of `src/lib/server/**` so
 * the component can import them. The server decorates the rows; the component
 * only renders them, so "which providers serve this model" is decided once.
 */

export interface PoolRowView {
	id: string;
	model: string;
	position: number;
	enabled: boolean;
	/** Month-to-date cap; 0 = no cap. */
	monthlyBudget: number;
	/** Month-to-date spend across every provider. */
	spent: number;
	/** Providers that serve the model, cheapest first (runtime order). */
	providers: { name: string; readiness: AiReadinessStatus; envName: string | null }[];
}

/** A model the operator can still add: enabled somewhere, not in the pool yet. */
export interface AvailableModel {
	model: string;
	providers: string[];
}

/**
 * Value of the assignment picker's "follow the pool" choice.
 *
 * The select doubles as a mode switch (off / pool / one gateway), so the two
 * non-provider modes need values that cannot be a provider name by accident.
 * `''` is off, this is the pool; a gateway literally named `__pool` would win in
 * `saveAssignments`, which is the only way the two can meet.
 */
export const POOL_MODE = '__pool';

export function usableProviders(row: PoolRowView): PoolRowView['providers'] {
	return row.providers.filter((provider) => provider.readiness === 'ready');
}

/**
 * True when the runtime would skip this row: switched off, or over budget.
 * "No provider" is a separate state - the row is configured but nothing can
 * serve it right now, which is worth its own badge.
 */
export function isPoolRowBlocked(row: PoolRowView): boolean {
	if (!row.enabled) return true;
	if (row.monthlyBudget > 0 && row.spent >= row.monthlyBudget) return true;
	return false;
}

/** `$0.12 / $1.00`, or `$0.12 / no cap`. */
export function budgetLabel(row: PoolRowView): string {
	return `${money(row.spent)} / ${row.monthlyBudget > 0 ? money(row.monthlyBudget) : '—'}`;
}

/**
 * Two decimals normally; more digits only where rounding would hide a real
 * amount. A single cheap call costs ~$0.00002, and printing "0.00 spent" next
 * to a call that happened reads as broken bookkeeping.
 */
export function money(value: number): string {
	if (value === 0) return '0.00';
	if (value >= 0.01) return value.toFixed(2);
	if (value >= 0.0001) return value.toFixed(4);
	return '<0.0001';
}

/**
 * Enabled models across all providers, deduped, minus the ones already pooled.
 * Only enabled entries qualify: the pool must never contain a model nobody can
 * actually call.
 */
export function addableModels(
	providers: readonly { name: string; models: AiModelEntry[] | null }[],
	pool: readonly { model: string }[]
): AvailableModel[] {
	const taken = new Set(pool.map((row) => row.model));
	const byModel = new Map<string, string[]>();
	for (const provider of providers) {
		for (const model of enabledModelIds(provider.models)) {
			if (taken.has(model)) continue;
			byModel.set(model, [...(byModel.get(model) ?? []), provider.name]);
		}
	}
	return [...byModel.entries()]
		.map(([model, names]) => ({ model, providers: names.sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => a.model.localeCompare(b.model));
}

/** Every enabled model across providers - the options for the assignment picker. */
export function assignableModels(
	providers: readonly { name: string; models: AiModelEntry[] | null }[]
): string[] {
	const models = new Set<string>();
	for (const provider of providers) {
		for (const model of enabledModelIds(provider.models)) models.add(model);
	}
	return [...models].sort((a, b) => a.localeCompare(b));
}

/** Pool entries in runtime order. */
export function orderedPool<T extends { position: number }>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => a.position - b.position);
}

/**
 * The same rows cheapest-first. `position` is the tie-break on purpose: sorting
 * must not scramble the operator's order among rows that cost the same, or
 * among unpriced rows (all `Infinity`).
 */
export function orderedPoolByPrice<T extends { model: string; position: number }>(
	rows: readonly T[],
	priceOf: (model: string) => number
): T[] {
	return [...rows].sort((a, b) => priceOf(a.model) - priceOf(b.model) || a.position - b.position);
}

/** What one provider can still contribute to the pool, and what it already owns. */ export interface ProviderBulk {
	name: string;
	/** Enabled models of this provider that are not pooled yet. */
	addable: string[];
	/** Pooled models this provider serves - i.e. what "remove" would drop. */
	removable: string[];
}

/**
 * The bulk picker's options: every provider that has something to add or
 * something to remove. Ordered by name so the list is stable between renders.
 *
 * `removable` is deliberately "pooled models this provider serves", not
 * "models only this provider serves": a bulk remove is an explicit action the
 * button spells out ("remove 2 models"), and hiding half of them because a
 * second gateway also offers them would be surprising.
 */
export function providerBulk(
	providers: readonly { name: string; models: AiModelEntry[] | null }[],
	pool: readonly PoolRowView[]
): ProviderBulk[] {
	const addable = addableModels(providers, pool);
	return providers
		.map((provider) => ({
			name: provider.name,
			addable: addable
				.filter((option) => option.providers.includes(provider.name))
				.map((option) => option.model),
			removable: pool
				.filter((row) => row.providers.some((entry) => entry.name === provider.name))
				.map((row) => row.model)
		}))
		.filter((entry) => entry.addable.length > 0 || entry.removable.length > 0)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pool models no provider lists any more - what a provider delete leaves behind.
 *
 * Any listing counts, enabled or not: disabling a model is reversible and must
 * not throw away the pool entry's order and budget, while deleting the provider
 * that was its only home cannot be undone.
 */
export function orphanedPoolModels(
	pooledModels: readonly string[],
	providers: readonly { models: AiModelEntry[] | null }[]
): string[] {
	const served = new Set<string>();
	for (const provider of providers) {
		for (const entry of provider.models ?? []) {
			if (entry && typeof entry.id === 'string' && entry.id) served.add(entry.id);
		}
	}
	return pooledModels.filter((model) => !served.has(model));
}

import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { aiModelPool, aiProviders } from '$lib/server/db/ai';
import { getOption } from '$lib/server/config/options-registry';
import { cheapestModelPrice, providersForModel } from '../ai/providers.ts';
import { memberReadiness, type ReadinessProvider } from './ai-readiness';
import { orphanedPoolModels, orderedPoolByPrice, type PoolRowView } from '$lib/utils/ai-pool';

/** The app handle or a transaction: callers pass whichever they write through. */
export type PoolDb = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

export interface PoolRow {
	id: string;
	model: string;
	position: number;
	enabled: boolean;
	/** Numeric column: keep the string so a huge value cannot lose precision. */
	monthlyBudget: string;
}

/** Stored rows in chain order. */
export async function listPool(handle: PoolDb = db): Promise<PoolRow[]> {
	const rows = await handle
		.select({
			id: aiModelPool.id,
			model: aiModelPool.model,
			position: aiModelPool.position,
			enabled: aiModelPool.enabled,
			monthlyBudget: aiModelPool.monthlyBudget
		})
		.from(aiModelPool)
		.orderBy(asc(aiModelPool.position), asc(aiModelPool.createdAt));
	return rows;
}

/**
 * Rows ready to render: spend, the providers that serve each model (runtime
 * order), and each provider's verdict. The card never re-derives any of it.
 */
export async function decoratePool(input: {
	rows: readonly PoolRow[];
	providers: readonly ReadinessProvider[];
	spent: Map<string, number>;
	hasEnv: (name: string) => boolean;
	runtimes: Map<string, string[]>;
}): Promise<PoolRowView[]> {
	return input.rows.map((row) => {
		const names = input.runtimes.get(row.model) ?? [];
		return {
			id: row.id,
			model: row.model,
			position: row.position,
			enabled: row.enabled,
			monthlyBudget: Number(row.monthlyBudget),
			spent: input.spent.get(row.model) ?? 0,
			providers: names.map((name) => {
				const provider = input.providers.find((candidate) => candidate.name === name) ?? null;
				const verdict = memberReadinessFor(provider, row.model, input.hasEnv);
				return { name, readiness: verdict.status, envName: verdict.envName };
			})
		};
	});
}

/**
 * One provider's verdict for one model. `memberReadiness` is the single source
 * of that answer, so a "ready" chip here means a slot pinned to this
 * provider+model would also read ready.
 */
function memberReadinessFor(
	provider: ReadinessProvider | null,
	model: string,
	hasEnv: (name: string) => boolean
) {
	return memberReadiness({ provider, model, hasEnv });
}

/** Provider names per pooled model, in the runtime's price order. */
export async function runtimesFor(
	models: readonly string[],
	handle: PoolDb = db
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const model of models) {
		const providers = await providersForModel(handle as never, model);
		out.set(
			model,
			providers.map((provider) => provider.name)
		);
	}
	return out;
}

/**
 * Rewrite `position` as 0..n-1. Called after add / remove / move: one writer
 * for the order beats patching two rows and hoping gaps never collide (the
 * column carries no unique constraint on purpose).
 */
export async function renumberPool(handle: PoolDb): Promise<void> {
	const rows = await handle
		.select({ id: aiModelPool.id })
		.from(aiModelPool)
		.orderBy(asc(aiModelPool.position), asc(aiModelPool.createdAt));
	await Promise.all(
		rows.map((row, position) =>
			handle.update(aiModelPool).set({ position }).where(eq(aiModelPool.id, row.id))
		)
	);
}

/**
 * Move one row one step and renumber. Returns false at the edges: the button is
 * disabled there, so a stale click is a no-op rather than an error.
 */
export async function movePoolRow(
	handle: PoolDb,
	input: { id: string; direction: 'up' | 'down' }
): Promise<boolean> {
	const rows = await handle
		.select({ id: aiModelPool.id })
		.from(aiModelPool)
		.orderBy(asc(aiModelPool.position), asc(aiModelPool.createdAt));
	const index = rows.findIndex((row) => row.id === input.id);
	if (index === -1) return false;
	const target = input.direction === 'up' ? index - 1 : index + 1;
	if (target < 0 || target >= rows.length) return false;
	const ordered = [...rows];
	[ordered[index], ordered[target]] = [ordered[target], ordered[index]];
	await Promise.all(
		ordered.map((row, position) =>
			handle.update(aiModelPool).set({ position }).where(eq(aiModelPool.id, row.id))
		)
	);
	return true;
}

/** Next free position at the end of the chain. */
export async function nextPosition(handle: PoolDb = db): Promise<number> {
	const rows = await listPool(handle);
	return rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
}

/**
 * Rewrite the order cheapest-first, using each model's cheapest provider.
 *
 * This is the same number the runtime already ranks candidates by, so "sorted
 * by price" means "the order the reader would end up discovering by hand" -
 * not a second opinion computed somewhere else. Rows that cost the same, or that
 * nothing can price, keep their current relative order.
 */
export async function sortPoolByPrice(handle: PoolDb = db): Promise<string[]> {
	const rows = await listPool(handle);
	if (rows.length < 2) return rows.map((row) => row.model);
	const pricing = await getOption('ai.pricing', handle as never);
	const prices = new Map<string, number>();
	for (const row of rows) {
		prices.set(row.model, await cheapestModelPrice(handle as never, row.model, pricing));
	}
	const ordered = orderedPoolByPrice(
		rows,
		(model) => prices.get(model) ?? Number.POSITIVE_INFINITY
	);
	await Promise.all(
		ordered.map((row, position) =>
			handle.update(aiModelPool).set({ position }).where(eq(aiModelPool.id, row.id))
		)
	);
	return ordered.map((row) => row.model);
}

/** Enabled provider rows, for the pickers (models + names). */
export async function providerOptions(handle: PoolDb = db) {
	const rows = await handle
		.select({
			id: aiProviders.id,
			name: aiProviders.name,
			enabled: aiProviders.enabled,
			models: aiProviders.models
		})
		.from(aiProviders)
		.orderBy(asc(aiProviders.name));
	return rows;
}

/**
 * Drop pool rows whose model no provider lists any more.
 *
 * Called after a provider is deleted: the pool is keyed by model, so a deleted
 * gateway does not dangle, but a model only it offered becomes a row nothing can
 * serve. A provider that merely *disabled* a model keeps the row, because
 * disabling is reversible and the operator's order / budget must survive it.
 * Returns the removed model ids.
 */
export async function pruneUnservedPool(handle: PoolDb): Promise<string[]> {
	const [rows, providers] = await Promise.all([listPool(handle), providerOptions(handle)]);
	const orphaned = orphanedPoolModels(
		rows.map((row) => row.model),
		providers
	);
	if (orphaned.length === 0) return [];
	await handle.delete(aiModelPool).where(inArray(aiModelPool.model, orphaned));
	await renumberPool(handle);
	return orphaned;
}

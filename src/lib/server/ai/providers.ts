import { asc, eq, gte, sql } from 'drizzle-orm';
import { aiModelPool } from '../db/ai/ai-model-pool.schema.ts';
import { aiProviders } from '../db/ai/ai-provider.schema.ts';
import { aiUsage } from '../db/ai/ai-usage.schema.ts';
import { getOption } from '../config/options-registry.ts';
import type { AiFunction, AiProviderKind } from '../../utils/ai-meta.ts';
import { enabledModelIds } from '../../utils/ai-meta.ts';
import type { AiPricing } from '../../utils/pricing.ts';
import { providerPrice } from '../../utils/pricing.ts';
import { AiError } from './errors.ts';
import type {
	AiAssignment,
	AiCandidate,
	AiDb,
	AiProviderRow,
	AiResolvedProvider
} from './types.ts';

const KNOWN_KINDS: readonly AiProviderKind[] = ['openai-compatible', 'deepl', 'custom'];

/** One row of the default pool, with its month-to-date spend. */
export interface PoolEntry {
	model: string;
	enabled: boolean;
	/** Month-to-date cap in `ai.budget.currency`; 0 = unlimited. */
	monthlyBudget: number;
	spent: number;
}

/**
 * Resolve `ai.assignments[functionSlot]` to the ordered chain of provider +
 * model pairs to try. Three shapes, exactly what the settings page offers:
 * a missing key means `no_assignment` (the slot is off); `{}` follows the
 * default pool from the top, each model on its cheapest provider first;
 * `{model}` / `{provider, model}` puts that model first and the pool's other
 * models behind it as fallbacks — `provider` only moves one gateway to the
 * front of that model's candidates. A model outside the pool has no
 * model-level fallback: naming one is a deliberate pin.
 */
export async function resolveProviderChain(
	db: AiDb,
	functionSlot: AiFunction
): Promise<AiCandidate[]> {
	const assignments = await getOption('ai.assignments', db);
	const assignment = assignments[functionSlot];
	if (!assignment) {
		throw new AiError('no_assignment', `No provider assigned to "${functionSlot}"`);
	}
	return chainFor(db, functionSlot, assignment);
}

/** True when the slot defers to the pool: the key exists but names nothing. */
export function followsPool(assignment: AiAssignment | undefined): boolean {
	return assignment != null && !assignment.provider && !assignment.model;
}

async function chainFor(
	db: AiDb,
	functionSlot: AiFunction,
	assignment: AiAssignment
): Promise<AiCandidate[]> {
	const [pool, pricing] = await Promise.all([poolEntries(db), getOption('ai.pricing', db)]);
	// Pool order is the whole answer when nothing is named; otherwise the named
	// model leads and the pool only orders the fallbacks.
	const primary = followsPool(assignment) ? null : await primaryModel(db, functionSlot, assignment);
	const entries = primary
		? (() => {
				const entry = pool.find((candidate) => candidate.model === primary);
				return entry
					? [entry, ...pool.filter((candidate) => candidate.model !== primary)]
					: [{ model: primary, enabled: true, monthlyBudget: 0, spent: 0 }];
			})()
		: pool;

	const chain: AiCandidate[] = [];
	/** First reason an entry produced nothing, so an empty chain can explain itself. */
	let skipped: AiError | null = null;

	for (const poolEntry of entries) {
		if (!poolEntry.enabled) continue;
		if (poolEntry.monthlyBudget > 0 && poolEntry.spent >= poolEntry.monthlyBudget) {
			skipped ??= new AiError(
				'model_budget',
				`Model "${poolEntry.model}" reached its monthly budget`,
				{ provider: null }
			);
			continue;
		}
		const providers = await providersForModel(db, poolEntry.model, pricing);
		if (providers.length === 0) {
			skipped ??= new AiError('no_model', `No enabled provider offers model "${poolEntry.model}"`);
			continue;
		}
		// A legacy assignment that still names a provider keeps that provider in
		// front; everything else is price order.
		const pin = poolEntry.model === primary ? assignment.provider : undefined;
		const ordered = pin
			? [...providers.filter((p) => p.name === pin), ...providers.filter((p) => p.name !== pin)]
			: providers;
		for (const provider of ordered) {
			chain.push({ provider, model: poolEntry.model, primaryModel: primary ?? poolEntry.model });
		}
	}
	if (chain.length > 0) return chain;
	if (primary === null) {
		throw (
			skipped ??
			new AiError('no_model', `The default pool has no model that "${functionSlot}" could use`)
		);
	}
	throw (
		skipped ??
		new AiError('no_model', `No enabled provider offers the model assigned to "${functionSlot}"`)
	);
}

/**
 * The model the slot asks for. `assignment.model` wins; a legacy row that only
 * names a provider falls back to that provider's first enabled model, which is
 * the rule this app used before the pool existed.
 */
async function primaryModel(
	db: AiDb,
	functionSlot: AiFunction,
	assignment: AiAssignment
): Promise<string> {
	let models: unknown = null;
	if (assignment.provider) {
		const [row] = await db
			.select({ models: aiProviders.models })
			.from(aiProviders)
			.where(eq(aiProviders.name, assignment.provider))
			.limit(1);
		if (!row) {
			throw new AiError('no_provider', `Provider "${assignment.provider}" not found`);
		}
		models = row.models;
	}
	const model = resolveModelName(assignment, models);
	if (!model) {
		throw new AiError('no_model', `No model configured for provider "${assignment.provider}"`);
	}
	return model;
}

/**
 * Every enabled provider that offers this model, cheapest first.
 *
 * Price order is the point of aggregating: when two gateways serve the same
 * model, the cheaper one runs and the other is the fallback. A provider with no
 * price entry sorts last rather than being excluded - "unpriced" must not mean
 * "unusable", and it still beats no candidate at all.
 */
export async function providersForModel(
	db: AiDb,
	model: string,
	pricing?: AiPricing
): Promise<AiProviderRow[]> {
	const rows = await db
		.select()
		.from(aiProviders)
		.where(eq(aiProviders.enabled, true))
		.orderBy(asc(aiProviders.name));
	const table = pricing ?? (await getOption('ai.pricing', db));
	const offered = rows
		.filter((row) => KNOWN_KINDS.includes(row.kind as AiProviderKind))
		.filter((row) => enabledModelIds(row.models).includes(model))
		.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind as AiProviderKind,
			baseUrl: row.baseUrl,
			apiKeyEnv: row.apiKeyEnv,
			models: row.models,
			enabled: row.enabled
		}));
	return offered.sort(
		(a, b) =>
			providerPrice(table, a.name, model) - providerPrice(table, b.name, model) ||
			a.name.localeCompare(b.name)
	);
}

/**
 * Cheapest price at which `model` can be called, across the providers a chain
 * would actually try. `Infinity` when nothing can serve it - the pool's
 * cheapest-first sort keeps those rows last instead of hiding them.
 */
export async function cheapestModelPrice(
	db: AiDb,
	model: string,
	pricing?: AiPricing
): Promise<number> {
	const [cheapest] = await providersForModel(db, model, pricing);
	if (!cheapest) return Number.POSITIVE_INFINITY;
	const table = pricing ?? (await getOption('ai.pricing', db));
	return providerPrice(table, cheapest.name, model);
}

/**
 * Pool entries in chain order, each with its month-to-date spend. One aggregate
 * query instead of one per entry: the pool is small but the ledger is not.
 */
export async function poolEntries(db: AiDb, now: Date = new Date()): Promise<PoolEntry[]> {
	const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const [rows, spend] = await Promise.all([
		db
			.select({
				model: aiModelPool.model,
				enabled: aiModelPool.enabled,
				monthlyBudget: aiModelPool.monthlyBudget
			})
			.from(aiModelPool)
			.orderBy(asc(aiModelPool.position), asc(aiModelPool.createdAt)),
		db
			.select({
				model: aiUsage.model,
				spent: sql<string>`coalesce(sum(${aiUsage.costEstimate}), 0)::text`
			})
			.from(aiUsage)
			.where(gte(aiUsage.createdAt, monthStart))
			.groupBy(aiUsage.model)
	]);
	const spentByModel = new Map(spend.map((row) => [row.model, Number(row.spent)]));
	return rows.map((row) => ({
		model: row.model,
		enabled: row.enabled,
		monthlyBudget: Number(row.monthlyBudget),
		spent: spentByModel.get(row.model) ?? 0
	}));
}

/**
 * Single-target resolution for the callers that run their own request loop
 * (the agent tools, the comment-review gate): the first link of the chain.
 */
export async function resolveProvider(
	db: AiDb,
	functionSlot: AiFunction
): Promise<AiResolvedProvider> {
	const assignments = await getOption('ai.assignments', db);
	const assignment = assignments[functionSlot];
	if (!assignment) {
		throw new AiError('no_assignment', `No provider assigned to "${functionSlot}"`);
	}
	const [candidate] = await chainFor(db, functionSlot, assignment);
	return { provider: candidate.provider, model: candidate.model, assignment };
}

/**
 * The one place that decides which model a slot resolves to. The runtime and
 * `ai-readiness` (display gate) both call it, so the readiness badge can never
 * claim something the runtime will not do. A blank `models[0]` is treated the
 * same as no model at all.
 */
export function resolveModelName(
	assignment: Pick<AiAssignment, 'model'>,
	models: unknown
): string | null {
	const model = assignment.model?.trim() || enabledModelIds(models)[0] || null;
	return model ? model : null;
}

export function defaultBaseUrl(kind: AiProviderKind): string {
	if (kind === 'deepl') return 'https://api.deepl.com/v2';
	// `custom` is the OpenAI-compatible extension slot: a self-hosted gateway
	// (LiteLLM, vLLM, Ollama's OpenAI endpoint, …) must expose /chat/completions.
	return 'https://api.openai.com/v1';
}

export function providerUrl(provider: AiProviderRow): string {
	const base = (provider.baseUrl?.trim() || defaultBaseUrl(provider.kind)).replace(/\/+$/, '');
	return provider.kind === 'deepl' ? `${base}/translate` : `${base}/chat/completions`;
}

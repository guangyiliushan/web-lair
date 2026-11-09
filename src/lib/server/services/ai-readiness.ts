import {
	AI_FUNCTIONS,
	enabledModelIds,
	type AiFunction,
	type AiReadinessStatus
} from '../../utils/ai-meta.ts';
import type { AiAssignment } from '../ai/types.ts';
import { followsPool, resolveModelName } from '../ai/providers.ts';

/**
 * Display gate for one AI function slot, shared by the AI settings page, the
 * AI console and the post/note editors.
 *
 * It is deliberately NOT the runtime: the pool (model fallbacks, per-model
 * budget) is not consulted here. Readiness answers one question - "if I press
 * the button now, will the assigned model run, and if not why" - and answers it
 * with the same model-first lookup the runtime uses, so the badge can never
 * promise a provider/model pair the runtime would refuse.
 *
 * The seventh state exists because configuration and capability are different
 * things: `chat`, `assistant` and `translation_review` have assignable slots
 * but no caller anywhere in the repo. A green light for those would be a lie.
 */

export type { AiReadinessStatus };

/** Only the fields readiness needs, so the caller can pass a row or a stub. */
export interface ReadinessProvider {
	name: string;
	enabled: boolean;
	apiKeyEnv: string | null;
	models: unknown;
}

export interface AiReadiness {
	status: AiReadinessStatus;
	/** Provider that would answer, when one can. */
	provider: string | null;
	model: string | null;
	/** Env var name the provider expects, when the failure is about the key. */
	envName: string | null;
	/** Where to go fix it. `null` when nothing is wrong or nothing is configurable. */
	fix: { href: string; labelKey: string } | null;
}

export interface ReadinessInput {
	providers: readonly ReadinessProvider[];
	assignments: Partial<Record<AiFunction, AiAssignment | undefined>>;
	/** Presence only - the secret itself is never read. */
	hasEnv: (name: string) => boolean;
	/** The default pool's models in order; needed by slots that follow it. */
	pool?: readonly string[];
}

/**
 * Slots with a caller in this repo. `chat` belongs here even though it does not
 * go through `resolveProviderChain`: `agent/run.ts` resolves that slot with
 * `resolveProvider`, so the conversation button is live and a "not wired" badge
 * next to it would be a lie. `translation_review` and `assistant` have no caller
 * anywhere - see `not_wired`.
 */
export const AI_WIRED_FUNCTIONS: readonly AiFunction[] = [
	'summary',
	'translation',
	'comment_review',
	'chat'
];

export const AI_SETTINGS_ASSIGNMENTS = '/admin/settings/ai#assignments';
export const AI_SETTINGS_PROVIDERS = '/admin/settings/ai#providers';

const FIX: Record<
	Exclude<AiReadinessStatus, 'ready' | 'not_wired'>,
	{ href: string; labelKey: string }
> = {
	unassigned: { href: AI_SETTINGS_ASSIGNMENTS, labelKey: 'admin_readiness_fix_assign' },
	provider_missing: { href: AI_SETTINGS_PROVIDERS, labelKey: 'admin_readiness_fix_provider' },
	provider_disabled: { href: AI_SETTINGS_PROVIDERS, labelKey: 'admin_readiness_fix_enable' },
	missing_env: { href: AI_SETTINGS_PROVIDERS, labelKey: 'admin_readiness_fix_env' },
	missing_model: { href: AI_SETTINGS_PROVIDERS, labelKey: 'admin_readiness_fix_model' }
};

/**
 * Copy keys live in `utils/ai-meta.ts` alongside the status type, because the
 * surfaces that render them cannot import from `src/lib/server/**`.
 */

function ready(provider: string, model: string): AiReadiness {
	return { status: 'ready', provider, model, envName: null, fix: null };
}

/**
 * The verdict for ONE provider + model pair. `readinessFor` and the pool card
 * both call it, so a provider chip the card shows as unusable is exactly what a
 * slot pinned to that provider would report.
 */
export function memberReadiness(input: {
	provider: ReadinessProvider | null;
	model?: string | null;
	hasEnv: (name: string) => boolean;
}): AiReadiness {
	const { provider } = input;
	if (!provider) {
		return {
			status: 'provider_missing',
			provider: null,
			model: null,
			envName: null,
			fix: FIX.provider_missing
		};
	}
	const model = input.model?.trim() || resolveModelName({}, provider.models);
	const envName = provider.apiKeyEnv ?? null;
	if (!provider.enabled) {
		return {
			status: 'provider_disabled',
			provider: provider.name,
			model,
			envName,
			fix: FIX.provider_disabled
		};
	}
	if (!model) {
		return {
			status: 'missing_model',
			provider: provider.name,
			model: null,
			envName,
			fix: FIX.missing_model
		};
	}
	if (envName && !input.hasEnv(envName)) {
		return { status: 'missing_env', provider: provider.name, model, envName, fix: FIX.missing_env };
	}
	return ready(provider.name, model);
}

/**
 * Resolve one slot. It mirrors the runtime's model-first rule: the assigned
 * model is looked up on every enabled provider, and the first provider whose
 * key is present wins. A slot still pinned to a provider that no longer serves
 * the model falls through to the next provider instead of reporting a dead end.
 */
export function readinessFor(fn: AiFunction, input: ReadinessInput): AiReadiness {
	const assignment = input.assignments[fn];

	if (!AI_WIRED_FUNCTIONS.includes(fn)) {
		// Capability gap, not a configuration gap: report what is configured so
		// the settings page can still show it, but never call it ready.
		const named = assignment?.provider ?? null;
		const providerRow = named
			? (input.providers.find((candidate) => candidate.name === named) ?? null)
			: null;
		return {
			status: 'not_wired',
			provider: named,
			model: resolveModelName(assignment ?? {}, providerRow?.models ?? null),
			envName: providerRow?.apiKeyEnv ?? null,
			fix: null
		};
	}

	if (!assignment) {
		return {
			status: 'unassigned',
			provider: null,
			model: null,
			envName: null,
			fix: FIX.unassigned
		};
	}

	// `{}` names nothing, so the slot runs the pool from the top. Report the
	// first pooled model that would answer - that is the one the runtime hits.
	if (followsPool(assignment)) {
		return poolReadiness(input);
	}

	const pinned = assignment.provider
		? (input.providers.find((candidate) => candidate.name === assignment.provider) ?? null)
		: null;
	if (assignment.provider && !pinned) {
		return {
			status: 'provider_missing',
			provider: assignment.provider,
			model: null,
			envName: null,
			fix: FIX.provider_missing
		};
	}

	const model = resolveModelName(assignment, pinned?.models ?? null);
	// A provider-only assignment with a disabled provider has no model to look
	// up, so "the provider is off" is the honest answer; with an explicit model
	// the pool may still serve it elsewhere, so the lookup continues below.
	if (pinned && !pinned.enabled && !assignment.model?.trim()) {
		return {
			status: 'provider_disabled',
			provider: pinned.name,
			model: null,
			envName: pinned.apiKeyEnv ?? null,
			fix: FIX.provider_disabled
		};
	}
	if (!model) {
		return {
			status: 'missing_model',
			provider: assignment.provider ?? null,
			model: null,
			envName: pinned?.apiKeyEnv ?? null,
			fix: FIX.missing_model
		};
	}
	return scanModel(model, input, pinned);
}

/**
 * A slot that follows the pool: the first pooled model someone can serve wins.
 * An empty pool is not "ready", it is "nothing to run", which reads exactly like
 * an unassigned slot to the person looking at the badge.
 */
function poolReadiness(input: ReadinessInput): AiReadiness {
	const models = input.pool ?? [];
	if (models.length === 0) {
		return {
			status: 'unassigned',
			provider: null,
			model: null,
			envName: null,
			fix: FIX.unassigned
		};
	}
	let firstBlocked: AiReadiness | null = null;
	for (const model of models) {
		const verdict = scanModel(model, input, null);
		if (verdict.status === 'ready') return verdict;
		firstBlocked ??= verdict;
	}
	return firstBlocked as AiReadiness;
}

/**
 * The providers that could answer `model`, in the order the runtime tries them
 * (a pinned provider first), with the first one that is actually usable.
 */
function scanModel(
	model: string,
	input: ReadinessInput,
	pinned: ReadinessProvider | null
): AiReadiness {
	const candidates = input.providers.filter(
		(provider) => provider.enabled && offers(provider, model)
	);
	if (candidates.length === 0) {
		return {
			status: 'missing_model',
			provider: pinned?.name ?? null,
			model,
			envName: null,
			fix: FIX.missing_model
		};
	}

	// The runtime tries the pinned provider first, then the rest; readiness
	// reports exactly the one that would answer. When none can, the FIRST reason
	// is reported - it belongs to the provider the runtime would hit first.
	const ordered = pinned
		? [
				...candidates.filter((entry) => entry.name === pinned.name),
				...candidates.filter((entry) => entry.name !== pinned.name)
			]
		: candidates;
	let firstBlocked: AiReadiness | null = null;
	for (const candidate of ordered) {
		const verdict = memberReadiness({ provider: candidate, model, hasEnv: input.hasEnv });
		if (verdict.status === 'ready') return verdict;
		firstBlocked ??= verdict;
	}
	return firstBlocked as AiReadiness;
}

/** True when this provider lists the model and has not disabled it. */
export function offers(provider: ReadinessProvider, model: string): boolean {
	return enabledModelIds(provider.models).includes(model);
}

/** Every slot at once - the shape all three surfaces render from. */
export function aiReadiness(input: ReadinessInput): Record<AiFunction, AiReadiness> {
	const out = {} as Record<AiFunction, AiReadiness>;
	for (const fn of AI_FUNCTIONS) out[fn] = readinessFor(fn, input);
	return out;
}

/** True when the slot can be used right now. */
export function isReady(readiness: AiReadiness): boolean {
	return readiness.status === 'ready';
}

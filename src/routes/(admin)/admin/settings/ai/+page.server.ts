import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiAgentMemories, aiModelPool, aiProviderSecrets, aiProviders } from '$lib/server/db/ai';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { adminContextFor, requireAdminRole, requireOwnerRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { SecretError } from '$lib/server/secrets/errors';
import {
	encryptProviderKeyValue,
	loadKeyring,
	readProviderKeyStatuses,
	resolveProviderKey,
	type SecretDb
} from '$lib/server/secrets/resolver';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { poolEntries } from '$lib/server/ai/providers';
import {
	decoratePool,
	listPool,
	movePoolRow,
	nextPosition,
	pruneUnservedPool,
	providerOptions,
	renumberPool,
	runtimesFor,
	sortPoolByPrice
} from '$lib/server/services/ai-model-pool';
import {
	parseProviderForm,
	providerFieldErrors,
	providerInputSchema,
	testProviderConnection,
	discoverProviderModels
} from '$lib/server/services/ai-providers';
import { isSafeRegexPattern } from '$lib/server/services/comment-moderation';
import {
	fetchPricingCatalog,
	mergePricing,
	resolveProviderPricing
} from '$lib/server/ai/pricing-catalog';
import type { AiPricingEntry } from '$lib/server/ai/types';
import { markManualEdits, parsePricingForm } from '$lib/utils/pricing';
import { assignableModels, POOL_MODE } from '$lib/utils/ai-pool';
import { isUuid } from '$lib/utils/uuid';
import {
	AI_FUNCTIONS,
	enabledModelIds,
	AI_PROVIDER_KINDS,
	mergeDiscoveredModels,
	mergeModelEntries,
	normalizeModelEntries,
	type AiProviderKind
} from '$lib/utils/ai-meta';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

function firstIssueMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	const key = issue.path.join('.');
	return key ? m.admin_settings_ai_issue({ key: key, message: issue.message }) : issue.message;
}

/** Field-keyed errors plus a form-level fallback row. */
type ProviderFailPayload = {
	message: string;
	providerErrors?: Record<string, string>;
};

/**
 * Pool actions answer with a keyed error so the card can show it where it
 * happened (currently only the add row).
 */
type PoolFailPayload = {
	message: string;
	poolErrors?: Record<string, string>;
};

/** Application rule for memory cards (AI-2): one owner, one small set of notes. */
const MEMORY_LIMIT = 50;

/** Provider key bounds (W2.5): a pasted credential, never a short PIN. */
const PROVIDER_KEY_MIN = 8;
const PROVIDER_KEY_MAX = 4096;

type KeyLocals = { user?: { id?: string } | null };
type KeyEventName = 'ai.key_missing' | 'ai.key_decrypt_failed' | 'ai.key_denied';

/**
 * Audit one secret failure without letting the audit path mask the real
 * answer. Payload carries identifiers and a hint only - never the value or the
 * ciphertext - and `deliver: false` keeps secret metadata off the webhook
 * plane (decision A2).
 */
async function recordKeyEvent(
	event: KeyEventName,
	input: {
		actorId: string | null;
		action?: string;
		providerId?: string | null;
		providerName?: string | null;
		hint?: string | null;
		reason?: string | null;
	}
): Promise<void> {
	try {
		await recordActivity(db, {
			event,
			actorId: input.actorId,
			refType: input.providerId ? 'ai' : undefined,
			refId: input.providerId ?? undefined,
			payload: {
				action: input.action ?? null,
				provider: input.providerName ?? null,
				hint: input.hint ?? null,
				reason: input.reason ?? null
			},
			deliver: false
		});
	} catch (error) {
		console.warn(
			'[secrets] key event not recorded',
			event,
			error instanceof Error ? error.name : 'unknown'
		);
	}
}

/** Owner-only secret writes; a refused attempt is itself an audited event. */
async function guardOwnerForSecret(locals: KeyLocals, action: string): Promise<void> {
	try {
		await requireOwnerRole();
	} catch (error) {
		await recordKeyEvent('ai.key_denied', {
			actorId: locals.user?.id ?? null,
			action
		});
		throw error;
	}
}

interface ProviderKeyLookup {
	getKey: (name: string) => string | undefined;
	failure: SecretError | null;
}

/**
 * Probe seam: resolve the same way a real call would, then hand the probe a
 * constant getter. `missing` degrades to the env lookup (the resolver already
 * tried it); terminal failures are returned so the action can answer with a
 * readable message instead of pretending the provider is unreachable.
 */
async function keyLookupForProvider(provider: {
	id?: string | null;
	apiKeyEnv?: string | null;
}): Promise<ProviderKeyLookup> {
	try {
		const resolved = await resolveProviderKey(db as unknown as SecretDb, provider, {
			getEnv: (name) => env[name]
		});
		return { getKey: () => resolved.value, failure: null };
	} catch (error) {
		if (error instanceof SecretError) {
			if (error.code === 'missing') {
				return { getKey: (name) => (name ? env[name] : undefined), failure: null };
			}
			return { getKey: () => undefined, failure: error };
		}
		throw error;
	}
}

/**
 * AI settings (ai-line plan 禮5.2): providers CRUD, feature assignments and
 * the switches/thresholds block. All three sections persist through the
 * options registry (validated writes) except providers, which live in
 * `ai_providers`; keys are only ever shown by NAME (env var, AI_*-namespaced),
 * never stored. Provider mutations that also touch `ai.assignments` run in a
 * single transaction so the two never drift (AI-2.1 review).
 */
export const load: PageServerLoad = async ({ locals }) => {
	await requireAdminRole();
	const [
		providers,
		assignments,
		moderation,
		budget,
		styleGuide,
		translation,
		summary,
		pricing,
		crawl,
		memories
	] = await Promise.all([
		db.select().from(aiProviders).orderBy(aiProviders.name),
		getOption('ai.assignments'),
		getOption('comments.moderation'),
		getOption('ai.budget'),
		getOption('ai.styleGuide'),
		getOption('ai.translation'),
		getOption('ai.summary'),
		getOption('ai.pricing'),
		getOption('ai.crawl'),
		db.select().from(aiAgentMemories).orderBy(desc(aiAgentMemories.createdAt))
	]);
	// Presence of the env var, not the secret - the UI only shows the name.
	const envSet = Object.fromEntries(
		providers.map((p) => [p.id, p.apiKeyEnv ? Boolean(env[p.apiKeyEnv]) : null])
	);
	// Encrypted rows (W2.5): status + hint only. The UI never receives the
	// ciphertext, let alone the key.
	const providerKeyStatuses = await readProviderKeyStatuses(
		db as unknown as SecretDb,
		providers.map((provider) => provider.id)
	);
	const providerKeys = Object.fromEntries(
		providers.map((provider) => [
			provider.id,
			providerKeyStatuses.get(provider.id) ?? {
				configured: false,
				hint: null,
				keyVersion: null,
				updatedAt: null
			}
		])
	);
	// A provider with a DB-managed key must not read as `missing_env` just
	// because the env variable is absent: readiness consumes this extra set.
	const dbKeyEnvNames = new Set(
		providers
			.filter((provider) => provider.apiKeyEnv && providerKeys[provider.id]?.configured)
			.map((provider) => provider.apiKeyEnv as string)
	);
	const hasKey = (name: string) => Boolean(env[name]) || dbKeyEnvNames.has(name);
	// The pool card needs, per row: providers that serve the model (runtime
	// order), each provider's verdict, and month-to-date spend. All three are
	// derived here so the component renders instead of deciding.
	const [poolRows, entries] = await Promise.all([listPool(), poolEntries(db)]);
	const pool = await decoratePool({
		rows: poolRows,
		providers: providers.map((provider) => ({
			name: provider.name,
			enabled: provider.enabled,
			apiKeyEnv: provider.apiKeyEnv,
			models: provider.models
		})),
		spent: new Map(entries.map((entry) => [entry.model, entry.spent])),
		hasEnv: hasKey,
		runtimes: await runtimesFor(poolRows.map((row) => row.model))
	});
	return {
		// Owner-only mutations: provider endpoints can move the bearer key, and
		// the budget/price table moves money. The layout owns the screen title,
		// so this page no longer sets `headerTitle`.
		canManage: adminContextFor(locals.user)?.role === 'owner',
		providers,
		pool,
		/** Every enabled model across providers - the assignment picker's options. */
		assignableModels: assignableModels(
			providers.map((provider) => ({ name: provider.name, models: provider.models }))
		),
		assignments,
		moderation,
		budget,
		styleGuide,
		translation,
		summary,
		pricing,
		crawl,
		memories,
		memoryLimit: MEMORY_LIMIT,
		envSet,
		providerKeys
	};
};

/**
 * Resolve the catalog against every model the app can call. Shared by the sync
 * preview and the sync write so the dialog can never describe a different diff
 * than the one that gets applied. Returns a ready-made failure payload instead
 * of throwing: both callers answer the operator, not a stack trace.
 */
async function resolveSyncPricing(): Promise<
	| {
			ok: true;
			current: Awaited<ReturnType<typeof getOption<'ai.pricing'>>>;
			synced: Record<string, AiPricingEntry>;
			unresolved: string[];
	  }
	| { ok: false; failure: ReturnType<typeof fail> }
> {
	const [providers, current, assignments] = await Promise.all([
		db.select().from(aiProviders),
		getOption('ai.pricing'),
		getOption('ai.assignments')
	]);
	let catalog;
	try {
		catalog = await fetchPricingCatalog();
	} catch (caught) {
		console.warn(
			'[ai] price catalog unavailable',
			caught instanceof Error ? caught.message : caught
		);
		return { ok: false, failure: fail(502, { message: m.admin_settings_ai_err_pricing_sync() }) };
	}
	// Models the app actually calls: the provider's own list plus whatever the
	// feature assignments point at (a stale model list must not hide a price).
	const assignedModels = new Map<string, string[]>();
	for (const slot of Object.values(assignments ?? {})) {
		if (!slot?.provider || !slot.model) continue;
		const list = assignedModels.get(slot.provider) ?? [];
		list.push(slot.model);
		assignedModels.set(slot.provider, list);
	}
	const synced: Record<string, AiPricingEntry> = {};
	const unresolved: string[] = [];
	for (const provider of providers) {
		// DeepL bills characters; the catalog prices tokens, and a token price
		// applied to a character bill would be wrong by orders of magnitude.
		if (provider.kind === 'deepl') continue;
		const models = new Set([
			...normalizeModelEntries(provider.models)
				.filter((model) => model.enabled)
				.map((model) => model.id),
			...(assignedModels.get(provider.name) ?? [])
		]);
		if (models.size === 0) continue;
		const resolved = resolveProviderPricing({
			name: provider.name,
			baseUrl: provider.baseUrl,
			models: [...models],
			catalog
		});
		Object.assign(synced, resolved.entries);
		// The catalog knows the vendor but not this model: the operator has to
		// price it by hand, and the dialog says so up front.
		for (const model of models) {
			if (!resolved.entries[`${provider.name}/${model}`]) {
				unresolved.push(`${provider.name}/${model}`);
			}
		}
	}
	if (Object.keys(synced).length === 0) {
		return {
			ok: false,
			failure: fail(409, { message: m.admin_settings_ai_err_pricing_sync_empty() })
		};
	}
	return { ok: true, current, synced, unresolved };
}

export const actions: Actions = {
	/**
	 * Write-only provider key (W2.5): paste a value, encrypt it with the active
	 * keyring version, upsert the row, audit set/rotate. The response never
	 * contains the value (or the ciphertext); the page reload shows a hint and
	 * the source badge.
	 */
	saveProviderKey: async ({ request, locals }) => {
		await guardOwnerForSecret(locals, 'saveProviderKey');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (!id) return fail(400, { message: m.admin_settings_ai_key_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_key_err_bad_id() });
		const value = (form.get('value') ?? '').toString().trim();
		if (value.length < PROVIDER_KEY_MIN || value.length > PROVIDER_KEY_MAX) {
			return fail(400, { message: m.admin_settings_ai_key_err_length() });
		}
		const [provider] = await db
			.select({ id: aiProviders.id, name: aiProviders.name })
			.from(aiProviders)
			.where(eq(aiProviders.id, id))
			.limit(1);
		if (!provider) return fail(404, { message: m.admin_settings_ai_key_err_not_found() });

		let encrypted;
		try {
			const keyring = loadKeyring({ getEnv: (name) => env[name] });
			encrypted = encryptProviderKeyValue(provider.id, value, keyring);
		} catch (error) {
			if (error instanceof SecretError) {
				console.warn('[secrets] provider key write refused:', error.code);
				return fail(503, { message: m.admin_settings_ai_key_err_store() });
			}
			throw error;
		}

		const actorId = locals.user?.id ?? null;
		try {
			const rotated = await db.transaction(async (tx) => {
				const existing = await tx
					.select({ providerId: aiProviderSecrets.providerId })
					.from(aiProviderSecrets)
					.where(eq(aiProviderSecrets.providerId, provider.id))
					.limit(1);
				const stamp = new Date();
				await tx
					.insert(aiProviderSecrets)
					.values({
						providerId: provider.id,
						ciphertext: encrypted.ciphertext,
						hint: encrypted.hint,
						keyVersion: encrypted.keyVersion,
						updatedBy: actorId
					})
					.onConflictDoUpdate({
						target: aiProviderSecrets.providerId,
						set: {
							ciphertext: encrypted.ciphertext,
							hint: encrypted.hint,
							keyVersion: encrypted.keyVersion,
							updatedBy: actorId,
							updatedAt: stamp
						}
					});
				const isRotation = existing.length > 0;
				await recordActivity(tx, {
					event: isRotation ? 'ai.key_rotate' : 'ai.key_set',
					actorId,
					refType: 'ai',
					refId: provider.id,
					payload: {
						provider: provider.name,
						hint: encrypted.hint,
						source: 'db',
						keyVersion: encrypted.keyVersion
					},
					// Secret metadata stays local (decision A2).
					deliver: false
				});
				return isRotation;
			});
			return {
				message: rotated ? m.admin_settings_ai_key_rotated() : m.admin_settings_ai_key_saved()
			};
		} catch (error) {
			if (error instanceof SecretError) {
				return fail(503, { message: m.admin_settings_ai_key_err_store() });
			}
			throw error;
		}
	},

	/** Remove the encrypted key; the provider's env fallback still applies. */
	clearProviderKey: async ({ request, locals }) => {
		await guardOwnerForSecret(locals, 'clearProviderKey');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (!id) return fail(400, { message: m.admin_settings_ai_key_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_key_err_bad_id() });
		const [provider] = await db
			.select({ id: aiProviders.id, name: aiProviders.name })
			.from(aiProviders)
			.where(eq(aiProviders.id, id))
			.limit(1);
		if (!provider) return fail(404, { message: m.admin_settings_ai_key_err_not_found() });
		const actorId = locals.user?.id ?? null;
		const removed = await db.transaction(async (tx) => {
			const rows = await tx
				.delete(aiProviderSecrets)
				.where(eq(aiProviderSecrets.providerId, provider.id))
				.returning({ providerId: aiProviderSecrets.providerId });
			if (rows.length === 0) return 0;
			await recordActivity(tx, {
				event: 'ai.key_clear',
				actorId,
				refType: 'ai',
				refId: provider.id,
				payload: { provider: provider.name },
				deliver: false
			});
			return rows.length;
		});
		if (removed === 0) {
			return fail(404, { message: m.admin_settings_ai_key_not_configured() });
		}
		return { message: m.admin_settings_ai_key_cleared() };
	},

	saveProvider: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		// Malformed ids never reach the uuid column (P1.1 review lesson).
		if (id && !isUuid(id)) {
			return fail(400, { message: m.admin_settings_ai_err_bad_id() } satisfies ProviderFailPayload);
		}
		const parsed = providerInputSchema.safeParse(parseProviderForm(form));
		if (!parsed.success) {
			return fail(400, {
				message: m.admin_settings_ai_err_check_form(),
				providerErrors: providerFieldErrors(parsed.error)
			});
		}
		try {
			if (id) {
				const outcome = await db.transaction(async (tx) => {
					const [existing] = await tx
						.select({ name: aiProviders.name, models: aiProviders.models })
						.from(aiProviders)
						.where(eq(aiProviders.id, id))
						.limit(1);
					if (!existing) return { found: false as const, renamed: 0 };
					// The textarea is the enabled set; disabled discovery records
					// survive so a later refresh can still show them.
					const models = mergeModelEntries(existing.models, parsed.data.models);
					await tx
						.update(aiProviders)
						.set({ ...parsed.data, models })
						.where(eq(aiProviders.id, id));
					if (existing.name === parsed.data.name) return { found: true as const, renamed: 0 };
					// Rename cascade: assignments reference providers by name, so
					// they must follow the rename or they turn into ghost entries
					// that block the whole assignments form (AI-2.1 review).
					const assignments = await getOption('ai.assignments', tx);
					let renamed = 0;
					const next: Record<string, { provider?: string; model?: string }> = {};
					for (const [fn, entry] of Object.entries(assignments)) {
						if (entry?.provider === existing.name) {
							next[fn] = { ...entry, provider: parsed.data.name };
							renamed += 1;
						} else {
							next[fn] = entry;
						}
					}
					if (renamed > 0) await setOption('ai.assignments', next, tx);
					return { found: true as const, renamed };
				});
				if (!outcome.found) return fail(404, { message: m.admin_settings_ai_err_not_found() });
				if (outcome.renamed > 0) {
					console.warn('[ai] provider renamed; assignments remapped', outcome.renamed);
					return { message: m.admin_settings_ai_flash_updated_synced({ count: outcome.renamed }) };
				}
				return { message: m.admin_settings_ai_flash_updated() };
			}
			await db
				.insert(aiProviders)
				.values({ ...parsed.data, models: mergeModelEntries(null, parsed.data.models) });
			return { message: m.admin_settings_ai_flash_created() };
		} catch (caught) {
			if (pgErrorCode(caught) === '23505') {
				console.warn('[ai] provider save rejected: duplicate name');
				return fail(400, {
					message: m.admin_settings_ai_err_name_taken(),
					providerErrors: { name: m.admin_settings_ai_err_name_taken() }
				});
			}
			throw caught;
		}
	},

	deleteProvider: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_settings_ai_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const outcome = await db.transaction(async (tx) => {
			const deleted = await tx
				.delete(aiProviders)
				.where(eq(aiProviders.id, id))
				.returning({ name: aiProviders.name });
			if (deleted.length === 0) {
				return { found: false as const, name: '', removed: 0, pruned: [] as string[] };
			}
			// Drop the provider from assignments so nothing points at a ghost.
			// Same transaction as the delete: a crash between the two used to
			// leave ghost entries behind (AI-2.1 review).
			const assignments = await getOption('ai.assignments', tx);
			const next = Object.fromEntries(
				Object.entries(assignments).filter(([, value]) => value?.provider !== deleted[0].name)
			);
			const removed = Object.keys(assignments).length - Object.keys(next).length;
			if (removed > 0) await setOption('ai.assignments', next, tx);
			// The pool is keyed by model, so nothing dangles - but a model only
			// this provider offered is now a row nothing can serve, and leaving it
			// would keep a dead link in the fallback chain.
			const pruned = await pruneUnservedPool(tx);
			return { found: true as const, name: deleted[0].name, removed, pruned };
		});
		if (!outcome.found) return fail(404, { message: m.admin_settings_ai_err_not_found() });
		if (outcome.pruned.length > 0) {
			console.warn('[ai] provider deleted; pool pruned', outcome.name, outcome.pruned.join(', '));
		}
		if (outcome.removed > 0 && outcome.pruned.length > 0) {
			return {
				message: m.admin_settings_ai_flash_deleted_both({
					name: outcome.name,
					count: outcome.removed,
					models: outcome.pruned.length
				})
			};
		}
		if (outcome.pruned.length > 0) {
			return {
				message: m.admin_settings_ai_flash_deleted_pool({
					name: outcome.name,
					models: outcome.pruned.length
				})
			};
		}
		if (outcome.removed > 0) {
			console.warn('[ai] provider deleted; assignments cleared', outcome.name, outcome.removed);
			return {
				message: m.admin_settings_ai_flash_deleted_removed({
					name: outcome.name,
					count: outcome.removed
				})
			};
		}
		console.warn('[ai] provider deleted', outcome.name);
		return { message: m.admin_settings_ai_flash_deleted({ name: outcome.name }) };
	},

	testProvider: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_settings_ai_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
		if (!provider) return fail(404, { message: m.admin_settings_ai_err_not_found() });
		// Probe with the same key a real call would use (W2.4/W2.5): the
		// encrypted row first, the env name as fallback.
		const lookup = await keyLookupForProvider(provider);
		if (lookup.failure) {
			await recordKeyEvent(
				lookup.failure.code === 'decrypt_failed' || lookup.failure.code === 'unknown_key_version'
					? 'ai.key_decrypt_failed'
					: 'ai.key_missing',
				{
					actorId: locals.user?.id ?? null,
					action: 'testProvider',
					providerId: provider.id,
					providerName: provider.name,
					reason: lookup.failure.code
				}
			);
			return {
				providerTest: {
					id,
					name: provider.name,
					ok: false,
					message:
						lookup.failure.code === 'store_unavailable'
							? m.admin_settings_ai_key_err_store()
							: m.admin_settings_ai_key_err_decrypt()
				}
			};
		}
		// Drizzle types the text column as string; the CHECK pins the enum.
		const result = await testProviderConnection(
			{
				kind: provider.kind as AiProviderKind,
				baseUrl: provider.baseUrl,
				apiKeyEnv: provider.apiKeyEnv
			},
			lookup.getKey
		);
		// The probe leaves a trace (name + verdict only, never a secret).
		console.warn('[ai] provider connection test', provider.name, result.ok ? 'ok' : result.message);
		// A failed check is a normal payload (it is a report, not an error).
		return { providerTest: { id, name: provider.name, ...result } };
	},

	refreshModels: async ({ request, locals }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (id && !isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const provider = id
			? (await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1))[0]
			: undefined;
		if (id && !provider) return fail(404, { message: m.admin_settings_ai_err_not_found() });
		// Probe what the dialog currently shows, not the saved row: a new
		// provider has no row yet, and an edited base URL / key name should be
		// tested before it is saved. Missing fields fall back to the saved row.
		const kindRaw = (form.get('kind') ?? provider?.kind ?? '').toString().trim();
		const kind = (AI_PROVIDER_KINDS as readonly string[]).includes(kindRaw)
			? (kindRaw as AiProviderKind)
			: 'openai-compatible';
		const baseUrl = (form.get('baseUrl') ?? provider?.baseUrl ?? '').toString().trim() || null;
		const apiKeyEnv =
			(form.get('apiKeyEnv') ?? provider?.apiKeyEnv ?? '').toString().trim() || null;
		const allowPrivateHosts = (env.AI_ALLOW_PRIVATE_HOSTS ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean);
		// A saved provider may carry an encrypted key; an unsaved dialog only
		// has the env name it is about to store.
		const lookup = provider
			? await keyLookupForProvider({ id: provider.id, apiKeyEnv })
			: ({ getKey: (name: string) => (name ? env[name] : undefined), failure: null } as const);
		if (lookup.failure) {
			await recordKeyEvent(
				lookup.failure.code === 'decrypt_failed' || lookup.failure.code === 'unknown_key_version'
					? 'ai.key_decrypt_failed'
					: 'ai.key_missing',
				{
					actorId: locals.user?.id ?? null,
					action: 'refreshModels',
					providerId: provider?.id ?? null,
					providerName: provider?.name ?? null,
					reason: lookup.failure.code
				}
			);
			return fail(400, {
				message:
					lookup.failure.code === 'store_unavailable'
						? m.admin_settings_ai_key_err_store()
						: m.admin_settings_ai_key_err_decrypt()
			});
		}
		const result = await discoverProviderModels({ kind, baseUrl, apiKeyEnv }, lookup.getKey, {
			allowPrivateHosts
		});
		if (!result.ok) return fail(400, { message: result.message });
		const models = mergeDiscoveredModels(
			provider?.models ?? null,
			result.models,
			new Date().toISOString()
		);
		// Discovery records only outlive the dialog once the provider exists;
		// a new provider stores the checked ids on save.
		if (provider) {
			await db
				.update(aiProviders)
				.set({ models, updatedAt: new Date() })
				.where(eq(aiProviders.id, provider.id));
		}
		return { message: result.message, discovered: models };
	},

	// ---- Feature assignments (pool order, or one pinned provider+model) ----
	saveAssignments: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const providers = await db
			.select({ name: aiProviders.name, enabled: aiProviders.enabled, models: aiProviders.models })
			.from(aiProviders);
		const byName = new Map(providers.map((provider) => [provider.name, provider]));
		// Pool mode may name one of its own models as a per-slot head start, so
		// the pool is the valid set for that branch.
		const poolModels = (
			await db
				.select({ model: aiModelPool.model })
				.from(aiModelPool)
				.where(eq(aiModelPool.enabled, true))
				.orderBy(aiModelPool.position)
		).map((row) => row.model);
		const next: Record<string, { provider?: string; model?: string }> = {};
		for (const fn of AI_FUNCTIONS) {
			// The first select is a mode, not a provider: off, follow the pool,
			// or pin one gateway. Only the last one needs a model.
			const mode = (form.get(`provider_${fn}`) ?? '').toString().trim();
			const model = (form.get(`model_${fn}`) ?? '').toString().trim();
			if (!mode) continue;
			if (mode === POOL_MODE && !byName.has(mode)) {
				if (!model) {
					// An empty object is the stored form of "whatever the pool says",
					// so reordering or adding pool rows changes this slot too.
					next[fn] = {};
					continue;
				}
				// Naming a pooled model gives this slot a head start; the rest of the
				// pool is still the fallback, so it can never be a dead end.
				if (!poolModels.includes(model)) {
					return fail(400, { message: m.admin_settings_ai_pool_err_not_enabled() });
				}
				next[fn] = { model };
				continue;
			}
			const row = byName.get(mode);
			if (!row) {
				console.warn('[ai] assignments save rejected: unknown provider');
				return fail(400, { message: m.admin_settings_ai_err_unknown({ provider: mode }) });
			}
			// A model the pinned provider does not offer would store a pin that
			// silently does nothing; refuse instead of half-lying.
			if (model && !enabledModelIds(row.models).includes(model)) {
				return fail(400, {
					message: m.admin_settings_ai_err_provider_model({ provider: mode, model })
				});
			}
			// No model means "that provider's first enabled model", the rule that
			// predates the pool; the picker normally sends one anyway.
			next[fn] = model ? { provider: mode, model } : { provider: mode };
		}
		try {
			await setOption('ai.assignments', next);
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_assignments() };
	},

	// ---- Default pool (model-first aggregation) ----
	addPoolModel: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const model = (form.get('model') ?? '').toString().trim();
		if (!model) {
			return fail(400, {
				message: m.admin_settings_ai_pool_err_model(),
				poolErrors: { model: m.admin_settings_ai_pool_err_model() }
			} satisfies PoolFailPayload);
		}
		// Only enabled models qualify: pooling a model nobody can call would put
		// a row in the chain that can never answer.
		const providers = await providerOptions();
		const offered = providers.some(
			(provider) => provider.enabled && enabledModelIds(provider.models).includes(model)
		);
		if (!offered) {
			const message = m.admin_settings_ai_pool_err_not_enabled();
			return fail(400, { message, poolErrors: { model: message } });
		}
		try {
			await db.insert(aiModelPool).values({ model, position: await nextPosition() });
		} catch (caught) {
			if (pgErrorCode(caught) === '23505') {
				const message = m.admin_settings_ai_pool_err_duplicate();
				return fail(400, { message, poolErrors: { model: message } });
			}
			throw caught;
		}
		await renumberPool(db);
		return { message: m.admin_settings_ai_pool_flash_saved() };
	},

	removePoolModel: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		await db.delete(aiModelPool).where(eq(aiModelPool.id, id));
		await renumberPool(db);
		return { message: m.admin_settings_ai_pool_flash_saved() };
	},

	movePoolModel: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const direction = (form.get('direction') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		if (direction !== 'up' && direction !== 'down') {
			return fail(400, { message: m.admin_settings_ai_err_missing() });
		}
		// An edge click is a no-op: the button is disabled there, and a stale
		// page must not turn that into a failure banner.
		await movePoolRow(db, { id, direction });
		return { message: m.admin_settings_ai_pool_flash_saved() };
	},

	/** Reorder the whole chain by price; the per-row up/down stays for manual taste. */
	sortPoolByPrice: async () => {
		await requireOwnerRole();
		const ordered = await sortPoolByPrice(db);
		return {
			message:
				ordered.length > 0
					? m.admin_settings_ai_pool_flash_sorted()
					: m.admin_settings_ai_pool_flash_saved()
		};
	},

	togglePoolModel: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const enabled = (form.get('enabled') ?? '').toString() === '1';
		const updated = await db
			.update(aiModelPool)
			.set({ enabled })
			.where(eq(aiModelPool.id, id))
			.returning({ id: aiModelPool.id });
		if (updated.length === 0)
			return fail(404, { message: m.admin_settings_ai_pool_err_not_found() });
		return { message: m.admin_settings_ai_pool_flash_saved() };
	},

	savePoolBudget: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const raw = (form.get('monthlyBudget') ?? '').toString().trim();
		// Empty clears the cap; anything else must be a non-negative number of
		// money units. `0` is accepted and means "no cap" too.
		const value = raw === '' ? 0 : Number(raw.replace(',', '.'));
		if (!Number.isFinite(value) || value < 0) {
			return fail(400, { message: m.admin_settings_ai_pool_err_budget() });
		}
		const updated = await db
			.update(aiModelPool)
			.set({ monthlyBudget: value.toFixed(2) })
			.where(eq(aiModelPool.id, id))
			.returning({ id: aiModelPool.id });
		if (updated.length === 0)
			return fail(404, { message: m.admin_settings_ai_pool_err_not_found() });
		return { message: m.admin_settings_ai_pool_flash_saved() };
	},

	/**
	 * Add or remove every pooled model of one provider. The card already knows
	 * which models those are (it derives the provider chain per row); this action
	 * recomputes the same set from the provider row so a stale page cannot add a
	 * model nobody offers or remove one that is still served elsewhere.
	 */
	bulkPoolModels: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const providerName = (form.get('provider') ?? '').toString().trim();
		const op = (form.get('op') ?? '').toString();
		if (!providerName) return fail(400, { message: m.admin_settings_ai_pool_err_provider() });
		if (op !== 'add' && op !== 'remove') {
			return fail(400, { message: m.admin_settings_ai_err_missing() });
		}
		const [provider] = await db
			.select({ models: aiProviders.models, enabled: aiProviders.enabled })
			.from(aiProviders)
			.where(eq(aiProviders.name, providerName))
			.limit(1);
		if (!provider) return fail(404, { message: m.admin_settings_ai_err_not_found() });
		const models = enabledModelIds(provider.models);
		if (models.length === 0) {
			return fail(400, { message: m.admin_settings_ai_pool_err_no_models() });
		}
		const existing = new Set((await listPool()).map((row) => row.model));
		if (op === 'add') {
			if (!provider.enabled) {
				return fail(400, { message: m.admin_settings_ai_pool_err_not_enabled() });
			}
			const missing = models.filter((model) => !existing.has(model));
			if (missing.length === 0) {
				return { message: m.admin_settings_ai_pool_flash_saved() };
			}
			let position = await nextPosition();
			for (const model of missing) {
				await db.insert(aiModelPool).values({ model, position: position++ });
			}
			await renumberPool(db);
			return {
				message: m.admin_settings_ai_pool_flash_bulk_add({ count: missing.length })
			};
		}
		const removable = models.filter((model) => existing.has(model));
		if (removable.length === 0) {
			return { message: m.admin_settings_ai_pool_flash_saved() };
		}
		await db.delete(aiModelPool).where(inArray(aiModelPool.model, removable));
		await renumberPool(db);
		return { message: m.admin_settings_ai_pool_flash_bulk_remove({ count: removable.length }) };
	},

	saveModeration: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const raw = (key: string) => (form.get(key) ?? '').toString().trim();
		const lines = (key: string) =>
			(form.get(key) ?? '')
				.toString()
				.split('\n')
				.map((s) => s.trim())
				.filter(Boolean);
		const linkRaw = raw('linkThreshold');
		const allowRaw = raw('allow');
		const blockRaw = raw('block');
		if (linkRaw === '') return fail(400, { message: m.admin_settings_ai_err_link_empty() });
		if (allowRaw === '') return fail(400, { message: m.admin_settings_ai_err_allow_empty() });
		if (blockRaw === '') return fail(400, { message: m.admin_settings_ai_err_block_empty() });
		const regexes = lines('regexes');
		for (const pattern of regexes) {
			try {
				new RegExp(pattern);
			} catch {
				return fail(400, { message: m.admin_settings_ai_err_regex({ pattern: pattern }) });
			}
			if (!isSafeRegexPattern(pattern)) {
				return fail(400, {
					message: m.admin_settings_ai_err_regex_unsafe({ pattern: pattern })
				});
			}
		}
		try {
			// Bounds and the allow < block ordering live in the registry schema
			// (single source of truth - AI-2.1 review).
			await setOption('comments.moderation', {
				enabled: form.get('enabled') !== null,
				shadowMode: form.get('shadowMode') !== null,
				keywords: lines('keywords'),
				regexes,
				linkThreshold: Number(linkRaw),
				firstCommentHold: form.get('firstCommentHold') !== null,
				trustedUsers: lines('trustedUsers'),
				thresholds: { allow: Number(allowRaw), block: Number(blockRaw) }
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_moderation() };
	},

	saveBudget: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const monthlyRaw = (form.get('monthly') ?? '').toString().trim();
		const monthly = monthlyRaw === '' ? 0 : Number(monthlyRaw);
		if (!Number.isFinite(monthly) || monthly < 0) {
			return fail(400, { message: m.admin_settings_ai_err_budget() });
		}
		// Empty ratios mean "keep the defaults"; garbage is an explicit error
		// (the old code inverted these - AI-2.1 review).
		const ratiosRaw = (form.get('alertRatios') ?? '').toString().trim();
		let alertRatios = [0.8, 0.9, 1];
		if (ratiosRaw !== '') {
			alertRatios = ratiosRaw.split(',').map((s) => Number(s.trim()));
			if (alertRatios.some((r) => !Number.isFinite(r) || r <= 0 || r > 10)) {
				return fail(400, { message: m.admin_settings_ai_err_ratios() });
			}
		}
		try {
			await setOption('ai.budget', {
				monthly,
				currency: (form.get('currency') ?? '').toString().trim() || 'USD',
				alertRatios,
				pauseAutoOnExceed: form.get('pauseAutoOnExceed') !== null
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_budget() };
	},

	saveStyleGuide: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		try {
			await setOption('ai.styleGuide', { text: (form.get('text') ?? '').toString() });
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_style() };
	},

	saveTranslation: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const minCharsRaw = (form.get('minChars') ?? '').toString().trim();
		if (minCharsRaw === '') return fail(400, { message: m.admin_settings_ai_err_min_chars() });
		try {
			await setOption('ai.translation', {
				minChars: Number(minCharsRaw),
				notesAuto: form.get('notesAuto') !== null,
				defaultMode: (form.get('defaultMode') ?? 'review').toString() as
					'auto' | 'review' | 'manual'
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_translation() };
	},

	saveSummary: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const minCharsRaw = (form.get('minChars') ?? '').toString().trim();
		if (minCharsRaw === '') return fail(400, { message: m.admin_settings_ai_err_min_chars() });
		try {
			await setOption('ai.summary', {
				auto: form.get('auto') !== null,
				minChars: Number(minCharsRaw)
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_summary() };
	},

	/**
	 * Row editor save. One row per `<provider>/<model>` key: the operator edits
	 * a cell, not a document. A wholly blank row is how a price is cleared, and
	 * a rejected cell fails the whole save instead of dropping the value - a
	 * silently dropped price looks exactly like "never priced" and quietly stops
	 * the budget from being enforceable.
	 */
	savePricing: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const current = await getOption('ai.pricing');
		const parsed = parsePricingForm({
			keys: form.getAll('key').map(String),
			inputPer1M: form.getAll('inputPer1M').map(String),
			outputPer1M: form.getAll('outputPer1M').map(String),
			per1MChars: form.getAll('per1MChars').map(String)
		});
		if (!parsed.ok) {
			return fail(400, {
				message: m.admin_settings_ai_err_pricing_rows(),
				pricingErrors: Object.fromEntries(
					Object.entries(parsed.errors).map(([index, cell]) => [index, String(cell)])
				)
			});
		}
		try {
			await setOption('ai.pricing', markManualEdits(parsed.pricing, current) as never);
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_pricing() };
	},

	/** Advanced escape hatch: paste / export the whole table as JSON. */
	savePricingJson: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const raw = (form.get('pricing') ?? '').toString().trim();
		let parsed: unknown;
		try {
			parsed = raw === '' ? {} : JSON.parse(raw);
		} catch {
			return fail(400, { message: m.admin_settings_ai_err_pricing_json() });
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return fail(400, { message: m.admin_settings_ai_err_pricing_json() });
		}
		try {
			await setOption('ai.pricing', parsed as never);
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_pricing() };
	},

	/**
	 * Fill the price table from the public models.dev catalog - the same table
	 * the cc-switch desktop switcher reads. Only entries the catalog can name
	 * for THIS provider are written; a hand-pinned price survives unless the
	 * operator ticks "overwrite". Nothing is guessed: an ambiguous model id
	 * stays unpriced and keeps counting towards the budget warning.
	 */
	syncPricing: async ({ request }) => {
		await requireOwnerRole();
		const form = await request.formData();
		const overwrite = form.get('overwrite') !== null;
		const resolved = await resolveSyncPricing();
		if (!resolved.ok) return resolved.failure;
		const merged = mergePricing({ current: resolved.current, synced: resolved.synced, overwrite });
		await setOption('ai.pricing', merged.pricing as never);
		return {
			message: m.admin_settings_ai_flash_pricing_sync({
				added: merged.added,
				updated: merged.updated,
				kept: merged.kept
			})
		};
	},

	/**
	 * Same resolution as `syncPricing`, but it writes nothing and reports the
	 * diff, so the confirmation can say exactly what will change before any
	 * price is replaced (a blind "sync" over hand-pinned prices is a data loss
	 * with no undo).
	 */
	previewPricingSync: async () => {
		await requireOwnerRole();
		const resolved = await resolveSyncPricing();
		if (!resolved.ok) return resolved.failure;
		const merged = mergePricing({
			current: resolved.current,
			synced: resolved.synced,
			overwrite: false
		});
		return {
			pricingSync: {
				added: merged.addedKeys,
				changed: merged.changedKeys,
				kept: merged.keptKeys,
				unresolved: resolved.unresolved
			}
		};
	},

	saveCrawl: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		try {
			await setOption('ai.crawl', {
				answerEngine: form.get('answerEngine') !== null,
				training: form.get('training') !== null
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_crawl() };
	},

	// Memory cards live under "context" beside the style guide: they are
	// injected into a model, not a usage record. They moved here from the AI
	// console, which observes and never mutates.
	saveMemory: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { message: m.admin_ai_err_content_required() });
		if (content.length > 2000) return fail(400, { message: m.admin_ai_err_content_too_long() });
		if (id) {
			if (!isUuid(id)) return fail(400, { message: m.admin_ai_err_bad_id() });
			const updated = await db
				.update(aiAgentMemories)
				.set({ content })
				.where(eq(aiAgentMemories.id, id))
				.returning({ id: aiAgentMemories.id });
			if (updated.length === 0) return fail(404, { message: m.admin_ai_err_memory_not_found() });
			return { message: m.admin_ai_flash_memory_updated() };
		}
		const [count] = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(aiAgentMemories);
		if (count.n >= MEMORY_LIMIT)
			return fail(400, { message: m.admin_ai_err_memory_limit({ count: MEMORY_LIMIT }) });
		await db.insert(aiAgentMemories).values({ content });
		return { message: m.admin_ai_flash_memory_created() };
	},

	deleteMemory: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_ai_err_bad_id() });
		const deleted = await db
			.delete(aiAgentMemories)
			.where(eq(aiAgentMemories.id, id))
			.returning({ id: aiAgentMemories.id });
		if (deleted.length === 0) return fail(404, { message: m.admin_ai_err_memory_not_found() });
		return { message: m.admin_ai_flash_memory_deleted() };
	}
} satisfies Actions;

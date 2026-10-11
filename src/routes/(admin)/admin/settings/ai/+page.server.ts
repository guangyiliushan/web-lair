import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiProviders } from '$lib/server/db/ai';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { requireAdminRole } from '$lib/server/authz';
import { getOption, setOption } from '$lib/server/config/options-registry';
import {
	parseProviderForm,
	providerFieldErrors,
	providerInputSchema,
	testProviderConnection
} from '$lib/server/services/ai-providers';
import { isUuid } from '$lib/utils/uuid';
import { AI_FUNCTIONS, type AiProviderKind } from '$lib/utils/ai-meta';
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
 * AI settings (ai-line plan §5.2): providers CRUD, feature assignments and
 * the switches/thresholds block. All three sections persist through the
 * options registry (validated writes) except providers, which live in
 * `ai_providers`; keys are only ever shown by NAME (env var, AI_*-namespaced),
 * never stored. Provider mutations that also touch `ai.assignments` run in a
 * single transaction so the two never drift (AI-2.1 review).
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [providers, assignments, moderation, budget, styleGuide, translation] = await Promise.all([
		db.select().from(aiProviders).orderBy(aiProviders.name),
		getOption('ai.assignments'),
		getOption('comments.moderation'),
		getOption('ai.budget'),
		getOption('ai.styleGuide'),
		getOption('ai.translation')
	]);
	return {
		headerTitle: m.admin_settings_ai(),
		providers,
		assignments,
		moderation,
		budget,
		styleGuide,
		translation,
		// Presence of the env var, not the secret - the UI only shows the name.
		envSet: Object.fromEntries(
			providers.map((p) => [p.id, p.apiKeyEnv ? Boolean(env[p.apiKeyEnv]) : null])
		)
	};
};

export const actions: Actions = {
	saveProvider: async ({ request }) => {
		await requireAdminRole();
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
						.select({ name: aiProviders.name })
						.from(aiProviders)
						.where(eq(aiProviders.id, id))
						.limit(1);
					if (!existing) return { found: false as const, renamed: 0 };
					await tx.update(aiProviders).set(parsed.data).where(eq(aiProviders.id, id));
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
			await db.insert(aiProviders).values(parsed.data);
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
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_settings_ai_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const outcome = await db.transaction(async (tx) => {
			const deleted = await tx
				.delete(aiProviders)
				.where(eq(aiProviders.id, id))
				.returning({ name: aiProviders.name });
			if (deleted.length === 0) return { found: false as const, name: '', removed: 0 };
			// Drop the provider from assignments so nothing points at a ghost.
			// Same transaction as the delete: a crash between the two used to
			// leave ghost entries behind (AI-2.1 review).
			const assignments = await getOption('ai.assignments', tx);
			const next = Object.fromEntries(
				Object.entries(assignments).filter(([, value]) => value?.provider !== deleted[0].name)
			);
			const removed = Object.keys(assignments).length - Object.keys(next).length;
			if (removed > 0) await setOption('ai.assignments', next, tx);
			return { found: true as const, name: deleted[0].name, removed };
		});
		if (!outcome.found) return fail(404, { message: m.admin_settings_ai_err_not_found() });
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

	testProvider: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_settings_ai_err_missing() });
		if (!isUuid(id)) return fail(400, { message: m.admin_settings_ai_err_bad_id() });
		const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
		if (!provider) return fail(404, { message: m.admin_settings_ai_err_not_found() });
		// Drizzle types the text column as string; the CHECK pins the enum.
		const result = await testProviderConnection(
			{
				kind: provider.kind as AiProviderKind,
				baseUrl: provider.baseUrl,
				apiKeyEnv: provider.apiKeyEnv
			},
			(name) => env[name]
		);
		// The probe leaves a trace (name + verdict only, never a secret).
		console.warn('[ai] provider connection test', provider.name, result.ok ? 'ok' : result.message);
		// A failed check is a normal payload (it is a report, not an error).
		return { providerTest: { id, name: provider.name, ...result } };
	},

	saveAssignments: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const providers = await db.select({ name: aiProviders.name }).from(aiProviders);
		const names = new Set(providers.map((p) => p.name));
		const next: Record<string, { provider?: string; model?: string }> = {};
		for (const fn of AI_FUNCTIONS) {
			const provider = (form.get(`assign_${fn}`) ?? '').toString().trim();
			const model = (form.get(`model_${fn}`) ?? '').toString().trim();
			if (!provider) continue;
			if (!names.has(provider)) {
				console.warn('[ai] assignments save rejected: unknown provider');
				return fail(400, { message: m.admin_settings_ai_err_unknown({ provider: provider }) });
			}
			next[fn] = { provider, ...(model ? { model } : {}) };
		}
		try {
			await setOption('ai.assignments', next);
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_assignments() };
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
		await requireAdminRole();
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
				notesAuto: form.get('notesAuto') !== null
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: m.admin_settings_ai_flash_translation() };
	}
} satisfies Actions;

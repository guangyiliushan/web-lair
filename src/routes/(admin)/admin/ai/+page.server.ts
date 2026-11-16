import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiModelPool, aiProviders, aiUsage } from '$lib/server/db/ai';
import { user } from '$lib/server/db/auth.schema';
import { notes, posts } from '$lib/server/db/content';
import { requireAdminRole, requireOwnerRole, adminContextFor } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { readBudgetState } from '$lib/server/ai';
import { aiReadiness, type ReadinessProvider } from '$lib/server/services/ai-readiness';
import { parseLedgerQuery, rangeStart } from '$lib/components/admin/ai/console-view';
import { recordActivity } from '$lib/server/audit';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/** Rows fetched per page. Paging is a `?before=<createdAt>` cursor later. */
const LIMIT = 100;

/**
 * The AI activity ledger (design spec 2026-11-03, surface C).
 *
 * This page observes almost everything through URL parameters only. The one
 * exception is `purgeUsage`, the owner-only housekeeping button: the ledger has
 * no per-row delete, so a wrong-project import or a runaway job can only be
 * cleaned up wholesale. Configuration lives under `/admin/settings/ai`.
 *
 * Readiness is computed here and shared verbatim by the settings page and the
 * editors, so the same configuration can never read three different ways.
 */
export const load: PageServerLoad = async ({ url, locals }) => {
	await requireAdminRole();

	const filters = parseLedgerQuery(url.searchParams);
	const start = rangeStart(filters.range, new Date());
	// One predicate list shared by the table and the roll-up: a scoped page that
	// shows unfiltered totals next to filtered rows reads as a bug.
	const scope = and(
		start ? gte(aiUsage.createdAt, start) : undefined,
		filters.task ? eq(aiUsage.task, filters.task) : undefined,
		filters.status ? eq(aiUsage.status, filters.status) : undefined,
		filters.provider ? eq(aiUsage.provider, filters.provider) : undefined,
		filters.relatedType && filters.relatedId
			? eq(aiUsage.relatedType, filters.relatedType)
			: undefined,
		filters.relatedType && filters.relatedId ? eq(aiUsage.relatedId, filters.relatedId) : undefined
	);

	const rows = await db
		.select({
			id: aiUsage.id,
			createdAt: aiUsage.createdAt,
			task: aiUsage.task,
			provider: aiUsage.provider,
			model: aiUsage.model,
			status: aiUsage.status,
			inputTokens: aiUsage.inputTokens,
			outputTokens: aiUsage.outputTokens,
			costEstimate: aiUsage.costEstimate,
			durationMs: aiUsage.durationMs,
			audioSeconds: aiUsage.audioSeconds,
			relatedType: aiUsage.relatedType,
			relatedId: aiUsage.relatedId
		})
		.from(aiUsage)
		.where(scope)
		.orderBy(desc(aiUsage.createdAt))
		.limit(LIMIT);

	// The month x feature x provider roll-up behind the "summary" view. Kept in
	// the same request so the toggle is instant and both views stay consistent.
	const summary = await db
		.select({
			month: sql<string>`to_char(${aiUsage.createdAt}, 'YYYY-MM')`,
			task: aiUsage.task,
			provider: aiUsage.provider,
			calls: sql<number>`count(*)`.mapWith(Number),
			inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)`.mapWith(Number),
			outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)`.mapWith(Number),
			cost: sql<number | null>`sum(${aiUsage.costEstimate})::float8`
		})
		.from(aiUsage)
		.where(scope)
		.groupBy(sql`to_char(${aiUsage.createdAt}, 'YYYY-MM')`, aiUsage.task, aiUsage.provider)
		.orderBy(sql`to_char(${aiUsage.createdAt}, 'YYYY-MM') desc`, aiUsage.task);

	// Cost attribution: the same range, grouped by actor. `null`
	// means an unattended job; the label is resolved here so the page does not
	// need a second lookup per row.
	const byActor = await db
		.select({
			actorId: aiUsage.actorId,
			name: user.name,
			email: user.email,
			calls: sql<number>`count(*)`.mapWith(Number),
			cost: sql<number | null>`sum(${aiUsage.costEstimate})::float8`
		})
		.from(aiUsage)
		.leftJoin(user, eq(aiUsage.actorId, user.id))
		.where(scope)
		.groupBy(aiUsage.actorId, user.name, user.email)
		.orderBy(desc(sql`count(*)`));

	const [budget, providers, assignments, poolModels] = await Promise.all([
		readBudgetState(db as never),
		db
			.select({
				name: aiProviders.name,
				enabled: aiProviders.enabled,
				apiKeyEnv: aiProviders.apiKeyEnv,
				models: aiProviders.models
			})
			.from(aiProviders)
			.orderBy(aiProviders.name),
		getOption('ai.assignments'),
		db
			.select({ model: aiModelPool.model })
			.from(aiModelPool)
			.where(eq(aiModelPool.enabled, true))
			.orderBy(aiModelPool.position)
	]);

	const readinessProviders: ReadinessProvider[] = providers.map((provider) => ({
		name: provider.name,
		enabled: provider.enabled,
		apiKeyEnv: provider.apiKeyEnv,
		models: provider.models
	}));

	const readiness = aiReadiness({
		providers: readinessProviders,
		assignments,
		// Presence only. The secret itself is never read or sent to the client.
		hasEnv: (name) => Boolean(env[name]),
		pool: poolModels.map((row) => row.model)
	});

	// `ai_usage` stores a pointer, not a denormalised title (the ledger must
	// stay true after a rename). One lookup per content type fills the gap for
	// the page, so the related column can show what the call actually touched.
	const postIds = rows.flatMap((row) =>
		row.relatedType === 'post' && row.relatedId ? [row.relatedId] : []
	);
	const noteIds = rows.flatMap((row) =>
		row.relatedType === 'note' && row.relatedId ? [row.relatedId] : []
	);
	const [postTitles, noteTitles] = await Promise.all([
		postIds.length
			? db
					.select({ id: posts.id, title: posts.title })
					.from(posts)
					.where(inArray(posts.id, postIds))
			: Promise.resolve([]),
		noteIds.length
			? db
					.select({ id: notes.id, title: notes.title })
					.from(notes)
					.where(inArray(notes.id, noteIds))
			: Promise.resolve([])
	]);
	const titles = new Map([...postTitles, ...noteTitles].map((row) => [row.id, row.title]));
	const ledgerRows = rows.map((row) => ({
		...row,
		relatedTitle: row.relatedId ? (titles.get(row.relatedId) ?? null) : null
	}));

	// Filter dropdowns read from the roll-up rather than a second `distinct`
	// query: it already spans the whole history, including providers that no
	// longer exist as rows - which a stale filter still has to be able to show.
	const taskOptions = [...new Set(summary.map((row) => row.task))].sort();
	const providerOptions = [...new Set(summary.map((row) => row.provider))].sort();

	const rawRow = url.searchParams.get('row');
	const openRow = rawRow && isUuid(rawRow) ? rawRow : null;

	return {
		headerTitle: m.admin_ai_title(),
		headerActions: [
			{
				// The header action bar holds one-word verbs like 对话 / 设置; the page
				// title keeps the longer "管理对话" it needs as a document title.
				label: m.admin_ai_chat_action(),
				iconName: 'brain',
				variant: 'outline',
				href: '/admin/ai/chat'
			},
			{
				label: m.admin_ai_transcribe_action(),
				iconName: 'microphone',
				variant: 'outline',
				href: '/admin/ai/transcribe'
			},
			{
				label: m.admin_ai_settings_action(),
				iconName: 'settings',
				variant: 'outline',
				href: '/admin/settings/ai'
			}
		],
		filters,
		limit: LIMIT,
		rows: ledgerRows,
		summary,
		byActor,
		taskOptions,
		providerOptions,
		openRow,
		budget,
		readiness,
		// Wholesale delete is the one action here that does not point at a row:
		// owner-only, and the button stays hidden rather than failing on click.
		canPurge: adminContextFor(locals.user)?.role === 'owner'
	};
};

export const actions: Actions = {
	/**
	 * Clear the whole ledger. Destructive on purpose: the monthly spend meter is
	 * derived from these rows, so wiping them also resets the budget guard (a
	 * paused automatic task starts again). The dialog says so; the activities
	 * row is the durable "who and when" record (the `/admin/maintenance` surface
	 * lists the job/schedule families only).
	 */
	purgeUsage: async ({ locals }) => {
		await requireOwnerRole();
		// One transaction: the wipe and its audit row share a fate. The event
		// name is two-segment (`ai.usage_purge`) because `activities_event_check`
		// only admits `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`; the old
		// `ai.usage.purge` raised 23514 with the rows already gone, so the action
		// 500ed on an emptied ledger. `returning` makes the receipt's count exact:
		// a separate COUNT takes its own READ COMMITTED snapshot and can disagree
		// with what the DELETE actually removed.
		const purged = await db.transaction(async (tx) => {
			const deleted = await tx.delete(aiUsage).returning({ id: aiUsage.id });
			await recordActivity(tx, {
				event: 'ai.usage_purge',
				actorId: locals.user?.id ?? null,
				payload: { rows: deleted.length }
			});
			return deleted.length;
		});
		return purged === 0
			? { message: m.admin_ai_purge_none() }
			: { message: m.admin_ai_purged({ count: purged }) };
	}
};

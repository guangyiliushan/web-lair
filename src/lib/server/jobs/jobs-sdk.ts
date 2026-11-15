import {
	getOption as registryGetOption,
	setOption as registrySetOption
} from '../config/options-registry.ts';
import { requireBoundDb } from './sdk-binding.ts';
import type { OptionKey, OptionValue } from '../config/options-registry.ts';
import type { JobsDb, JobContext } from './types.ts';

/**
 * Repository jobs SDK (J-2, plan §5.5): the single non-`node:*` module builtin
 * and user job files may import. On the repository side `#jobs-sdk` maps to
 * this file (root package.json `imports`); inside `$DATA_DIR/jobs` the
 * scaffold-generated `_sdk.runtime.ts` re-exports it, so forked jobs keep
 * running from the user layer. A unit test pins this module's export names
 * against the hand-written facade (`sdk-facade.d.ts`) in both directions.
 *
 * Bare `getOption` / `setOption` / `db` calls resolve against the client the
 * drain binds for the current run (`sdk-binding.ts`); they throw a clear
 * error outside a run instead of reaching for the web-only `$lib/server/db`.
 */

/** Executor accepted by the option helpers (registry handle or transaction). */
type RegistryExecutor = NonNullable<Parameters<typeof registryGetOption>[1]>;

/** Read a validated option; defaults to the run-bound client. */
export function getOption<K extends OptionKey>(
	key: K,
	executor?: RegistryExecutor
): Promise<OptionValue<K>> {
	return registryGetOption(key, executor ?? requireBoundDb());
}

/** Validate and upsert an option; defaults to the run-bound client. */
export function setOption<K extends OptionKey>(
	key: K,
	value: OptionValue<K>,
	executor?: RegistryExecutor
): Promise<void> {
	return registrySetOption(key, value, executor ?? requireBoundDb());
}

/** The run-bound database handle (function form; throws outside a run). */
export function getDb(): JobsDb {
	return requireBoundDb();
}

/**
 * The run-bound database handle as a value. Reads delegate to the bound
 * client, so `db.select(...)` chains work with no extra threading; using it
 * outside a run throws (same guard as `getDb()`).
 */
export const db: JobsDb = new Proxy({} as unknown as JobsDb, {
	get(_target, property) {
		const client = requireBoundDb();
		const value = Reflect.get(client as object, property);
		return typeof value === 'function'
			? (value as (...args: unknown[]) => unknown).bind(client)
			: value;
	}
});

// ---------------------------------------------------------------------------
// Re-exports (grill R1-3: curated surface - widen deliberately, one line each)
// ---------------------------------------------------------------------------

export {
	sql,
	and,
	or,
	eq,
	ne,
	lt,
	lte,
	gt,
	gte,
	inArray,
	notInArray,
	isNull,
	isNotNull,
	desc,
	asc
} from 'drizzle-orm';
export { activities } from '../db/system/activity.schema.ts';
export { aiAgentConversations } from '../db/ai/ai-agent-conversation.schema.ts';
export { aiUsage } from '../db/ai/ai-usage.schema.ts';
export { jobRuns } from '../db/system/job-run.schema.ts';
export { subscriptions } from '../db/system/subscription.schema.ts';
export { webhookDeliveries } from '../db/system/webhook-delivery.schema.ts';
export { deriveAcceptedHosts, publicOrigin, runLinkCheck } from '../links/job.ts';
export { EMAIL_RETENTION_DAYS, pruneOutdated, prunePrecheckRuns } from '../links/prune.ts';
export { REVISION_KEEP_PER_POST, pruneRevisions } from '../maintenance/revisions.ts';
export { DRAFT_ORPHAN_GRACE_DAYS, purgeOrphans } from '../maintenance/orphans.ts';
export { TRASH_GRACE_DAYS, purgeTrashedPosts } from '../maintenance/trash.ts';
export { links } from '../db/content/link.schema.ts';
export { comments } from '../db/content/comment.schema.ts';
export { runSync } from '../projects/sync.ts';
export { runJobsTypecheck } from './typecheck.ts';

/**
 * AI job cores are loaded lazily: importing the AI graph pulls the content
 * schemas (and their extension-explicit transitive imports) into every
 * `#jobs-sdk` consumer, including the user-script typechecker. The job files
 * still see a plain function, and the heavy module only loads when the job
 * actually runs.
 */
export async function runTranslationJob(ctx: JobContext): Promise<void> {
	const mod = await import('../ai/translation-job.ts');
	await mod.runTranslationJob(ctx);
}

export async function runSummaryJob(ctx: JobContext): Promise<void> {
	const mod = await import('../ai/summary-job.ts');
	await mod.runSummaryJob(ctx);
}

export async function runCommentReviewJob(ctx: JobContext): Promise<void> {
	const mod = await import('../ai/comment-review-job.ts');
	await mod.runCommentReviewJob(ctx);
}

/**
 * Discarded-translation sweep, invoked by `jobs.prune`. Lazy for the same
 * reason the job cores are: `translations` imports the content schema graph.
 */
export async function runTranslationsPrune(ctx: JobContext, now?: Date): Promise<number> {
	const mod = await import('../ai/translation-retention.ts');
	return mod.pruneDiscardedTranslations(ctx.db as never, now);
}
export type { TypecheckSummary } from './typecheck.ts';
export type { JobContext, JobLogger, JobsDb, JobsQueryable, LoadedJob } from './types.ts';
export type { JobResult, JobTrigger } from '../db/system/job-run.schema.ts';

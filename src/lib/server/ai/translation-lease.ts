import { and, eq, isNull, sql } from 'drizzle-orm';
import { translations } from '../db/content/translation.schema.ts';
import type { TranslationProgress } from '../db/content/translation.schema.ts';
import type { JobsDb } from '../jobs/types.ts';

/**
 * Lease + failure accounting for `translations` rows (translation runtime,
 * Task B). Claiming is a single Postgres statement: the `SELECT ... FOR UPDATE
 * SKIP LOCKED` subquery picks one pending row while the outer `UPDATE` stamps
 * the lease, so two workers cannot bill the same row twice. A worker that dies
 * after claiming leaves only `heartbeat_at` behind; 90s later the next tick
 * reclaims the row, and `runs < 20` stops a row from spinning forever.
 */
export type LeaseDb = Pick<JobsDb, 'select' | 'update'>;

export type { TranslationProgress };

export type ClaimedTranslation = {
	id: string;
	attempt: number;
	runs: number;
	stage: string | null;
	sourcePostId: string | null;
	sourceNoteId: string | null;
	targetLang: string;
	/** Who asked for this run; null when the auto-translate scanner did. */
	requestedBy: string | null;
	progress: TranslationProgress | null;
};

/** Claims per row before it is considered a crash loop (not a failure count). */
export const MAX_RUNS = 20;
/** A lease with no heartbeat for this long may be taken over. */
export const HEARTBEAT_STALE_SECONDS = 90;
/** Failed attempts before the row is abandoned. */
export const MAX_ATTEMPTS = 3;
/** Terminal copy for an abandoned row (the drawer derives its label from it). */
export const TRANSLATION_ABANDONED_ERROR = 'abandoned after 3 failed attempts';
/** Terminal copy for a row that burned every claim without ever parking. */
export const TRANSLATION_CRASH_LOOP_ERROR = 'abandoned after 20 runs without progress';

const STALE_LEASE = sql.raw(`interval '${HEARTBEAT_STALE_SECONDS} seconds'`);

/**
 * Claim one pending row. The `now` seam exists for deterministic tests; in
 * production the lease is always stamped with the database clock, which is
 * also the clock the staleness window compares against.
 *
 * `excludeIds` is the tick's memory: a row this worker already parked (or
 * failed) still matches the predicate, so without the exclusion the next
 * iteration of the batch loop would claim it again, burn its `runs` budget and
 * starve every other row.
 */
export async function claimTranslationRow(
	db: LeaseDb,
	excludeIds: readonly string[] = [],
	now?: Date
): Promise<ClaimedTranslation | null> {
	const leasedAt = now ? sql`${now}` : sql`now()`;
	const exclude =
		excludeIds.length > 0
			? sql`and ${translations.id} not in (${sql.join(
					excludeIds.map((id) => sql`${id}`),
					sql`, `
				)})`
			: sql``;
	const [row] = await db
		.update(translations)
		.set({
			startedAt: leasedAt,
			heartbeatAt: leasedAt,
			runs: sql`${translations.runs} + 1`,
			// Task C resumes at `progress.done`; until then every fresh claim
			// starts at the body phase.
			stage: sql`coalesce(${translations.stage}, 'body')`,
			// A claim always starts un-cancelled; `discardTranslation` sets the
			// flag for a run that is already in flight.
			cancelRequested: false,
			// The previous run is no longer parked: it is being retried now.
			waitingReason: null
		})
		.where(
			sql`${translations.id} = (
				select ${translations.id} from ${translations}
				where ${translations.status} = 'draft'
					and ${translations.content} is null
					and ${translations.error} is null
					and ${translations.runs} < ${sql.raw(String(MAX_RUNS))}
						and (${translations.heartbeatAt} is null or ${translations.heartbeatAt} < now() - ${STALE_LEASE})
					${exclude}
				order by ${translations.createdAt}
				limit 1
				for update skip locked
			)`
		)
		.returning({
			id: translations.id,
			attempt: translations.attempt,
			runs: translations.runs,
			stage: translations.stage,
			sourcePostId: translations.sourcePostId,
			sourceNoteId: translations.sourceNoteId,
			targetLang: translations.targetLang,
			requestedBy: translations.requestedBy,
			progress: translations.progress
		});
	return row ?? null;
}

/**
 * Give up on rows that have been claimed `MAX_RUNS` times without ever
 * reaching a parked or failed state. `markTranslationWaiting` resets `runs`,
 * so a rate-limited row never lands here; only a crash loop does. The same
 * staleness window as the claim keeps a live lease out of the sweep, and the
 * sweep runs before the tick's first claim so an abandoned row stops starving
 * the rest of the queue.
 */
export async function sweepTranslationCrashLoops(db: LeaseDb): Promise<number> {
	const rows = await db
		.update(translations)
		.set({ error: TRANSLATION_CRASH_LOOP_ERROR, progress: null, updatedAt: sql`now()` })
		.where(
			sql`${translations.status} = 'draft'
				and ${translations.content} is null
				and ${translations.error} is null
				and ${translations.runs} >= ${sql.raw(String(MAX_RUNS))}
				and (${translations.heartbeatAt} is null or ${translations.heartbeatAt} < now() - ${STALE_LEASE})`
		)
		.returning({ id: translations.id });
	return rows.length;
}

/** Keep the lease alive while a long generation runs. */
export async function heartbeatTranslation(db: LeaseDb, id: string): Promise<void> {
	await db
		.update(translations)
		.set({ heartbeatAt: sql`now()` })
		.where(eq(translations.id, id));
}

/**
 * Hand the lease back without touching `attempt`: a run stopped by the run
 * budget did not fail, so the next tick must be able to claim it immediately
 * instead of waiting out the 90s staleness window.
 */
export async function releaseTranslation(db: LeaseDb, id: string): Promise<void> {
	await db.update(translations).set({ heartbeatAt: null }).where(eq(translations.id, id));
}

/**
 * Record one real generation failure. Until the cap the row must stay
 * claimable, and the claim requires `error is null`, so the cause is only
 * surfaced through the job log; at the cap the row is abandoned with the
 * terminal copy. `runs` is deliberately not reset: it counts claims, and the
 * crash-loop guard must keep counting.
 */
export async function failTranslationAttempt(
	db: LeaseDb,
	id: string
): Promise<{ attempt: number; abandoned: boolean }> {
	const nextAttempt = sql`${translations.attempt} + 1`;
	const [row] = await db
		.update(translations)
		.set({
			attempt: nextAttempt,
			error: sql`case when ${nextAttempt} >= ${sql.raw(String(MAX_ATTEMPTS))} then ${TRANSLATION_ABANDONED_ERROR} else null end`,
			// Let the next tick re-enter the body phase instead of resuming a
			// phase the failed attempt never finished.
			stage: null,
			// A failure is not a pause; the row is not waiting for a retry
			// window, it is retried by the next claim.
			waitingReason: null,
			// Finished chunks survive a failure so the next claim resumes;
			// only a row that burned every attempt loses them. `partial` is a
			// preview of the interrupted chunk, never reusable.
			progress: sql`case when ${nextAttempt} >= ${sql.raw(String(MAX_ATTEMPTS))} then null else ${translations.progress} - 'partial' end`,
			// The next run regenerates from scratch only when no chunk survived.
			heartbeatAt: null
		})
		.where(
			and(eq(translations.id, id), eq(translations.status, 'draft'), isNull(translations.content))
		)
		.returning({ attempt: translations.attempt });
	if (!row) return { attempt: 0, abandoned: false };
	return { attempt: row.attempt, abandoned: row.attempt >= MAX_ATTEMPTS };
}

/**
 * A rate limit, a network outage or a paused budget is not the row's failure:
 * keep `error` null (so the row stays claimable), surface the pause as
 * `stage='waiting'`, record why, and drop the heartbeat so the next tick
 * retries at once. `runs` returns to 0 for a provider/budget pause: a clean
 * park is not a crash loop, and without the reset a long rate limit would
 * exhaust the crash-loop budget. A `network` failure keeps counting, because a
 * connection that never recovers must eventually be abandoned instead of
 * retrying (and possibly billing) forever.
 */
export async function markTranslationWaiting(
	db: LeaseDb,
	id: string,
	reason: string,
	options: { resetRuns?: boolean } = {}
): Promise<void> {
	const resetRuns = options.resetRuns ?? true;
	await db
		.update(translations)
		.set({
			stage: 'waiting',
			waitingReason: reason,
			error: null,
			// The retry resumes at the first unfinished chunk; the partial
			// preview of the interrupted one is not reusable.
			progress: sql`${translations.progress} - 'partial'`,
			heartbeatAt: null,
			...(resetRuns ? { runs: 0 } : {})
		})
		.where(
			and(eq(translations.id, id), eq(translations.status, 'draft'), isNull(translations.content))
		);
}

/** True once the row was discarded (or accepted) while the run was in flight. */
export async function isTranslationCancelled(db: LeaseDb, id: string): Promise<boolean> {
	const [row] = await db
		.select({ status: translations.status, cancelRequested: translations.cancelRequested })
		.from(translations)
		.where(eq(translations.id, id))
		.limit(1);
	if (!row) return true;
	return row.status !== 'draft' || row.cancelRequested;
}

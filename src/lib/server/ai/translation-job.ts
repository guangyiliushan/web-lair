import { and, eq, isNull, sql } from 'drizzle-orm';
import { translations } from '../db/content/translation.schema.ts';
import type { TranslationProgressChunk } from '../db/content/translation.schema.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import { isAiError } from './errors.ts';
import { generateTranslation } from './translate.ts';
import {
	MAX_ATTEMPTS,
	claimTranslationRow,
	failTranslationAttempt,
	heartbeatTranslation,
	isTranslationCancelled,
	markTranslationWaiting,
	releaseTranslation,
	sweepTranslationCrashLoops
} from './translation-lease.ts';
import type { AiDeps } from './types.ts';
import type { TranslationCandidate } from './translate.ts';
import type { JobContext } from '../jobs/types.ts';

const BATCH = 3;
/**
 * A drain tick is hard-capped at 900s (`jobs/registry.ts`); a timed-out tick
 * exits the process (`drain.ts` turns `JobTimeoutError` into a tick abort).
 * Stop starting new rows at 600s so the tick returns cleanly and the next one
 * picks up the remainder instead of killing an in-flight translation.
 */
const RUN_BUDGET_MS = 600_000;
/**
 * One body call may take minutes on a 24k-character source; 60s (the client
 * default) guaranteed a timeout there. Two attempts keep the worst case for
 * one call at 360s, which still fits inside the run budget.
 */
const ATTEMPT_TIMEOUT_MS = 180_000;
/**
 * A streamed body is bounded by idle gaps (30s without a chunk), not by a
 * fixed wall clock: 8k output tokens already takes 130-200s, so the 180s cap
 * would abort a healthy stream mid-body. This is only the outer backstop.
 */
const STREAM_TIMEOUT_MS = 600_000;
const ATTEMPTS = 2;
/** Lease heartbeat: well inside the 90s staleness window the claim trusts. */
const HEARTBEAT_MS = 5_000;
/**
 * Not the row's fault: the provider asked us to slow down, the network is
 * down, or the automatic budget is paused. The row stays pending, keeps
 * `error = NULL`, and is visible as `stage = 'waiting'`.
 */
const WAITING_CODES: ReadonlySet<string> = new Set(['rate_limit', 'network', 'budget']);

function startHeartbeat(ctx: JobContext, id: string): () => void {
	const timer = setInterval(() => {
		void heartbeatTranslation(ctx.db, id).catch((caught: unknown) => {
			ctx.logger.warn(`translation ${id} heartbeat failed: ${sanitizeErrorText(caught)}`);
		});
	}, HEARTBEAT_MS);
	// The drain process must be able to exit once the tick's work is done.
	timer.unref?.();
	return () => clearInterval(timer);
}

/** How often the streaming preview is allowed to reach the database. */
const PROGRESS_WRITE_MS = 1_000;

/**
 * Live preview writer. The generation streams hundreds of deltas; each one
 * must not become a database round trip, so writes are throttled and the
 * whole accumulated text is stored rather than a diff. The drawer reads
 * `progress.partial` through its status poll.
 */
function startProgressWriter(
	ctx: JobContext,
	id: string
): {
	onProgress: (text: string) => void;
	flush: () => Promise<void>;
} {
	let lastWrite = 0;
	let pending: string | null = null;
	let writing: Promise<void> | null = null;
	const write = async (): Promise<void> => {
		if (pending === null) return;
		const partial = pending;
		pending = null;
		lastWrite = Date.now();
		try {
			await ctx.db
				.update(translations)
				.set({
					// Merge, never replace: the chunked path keeps `total/done/chunks`
					// in the same object, and one preview frame must not wipe them.
					progress: sql`jsonb_set(
						coalesce(${translations.progress}, '{"total":0,"done":0,"chunks":[]}'::jsonb),
						'{partial}',
						to_jsonb(${partial}::text)
					)`
				})
				.where(and(eq(translations.id, id), eq(translations.status, 'draft')));
		} catch (caught) {
			ctx.logger.warn(`translation ${id} preview write failed: ${sanitizeErrorText(caught)}`);
		}
	};
	const run = (): void => {
		writing = write().finally(() => {
			writing = null;
		});
	};
	return {
		onProgress(text: string) {
			pending = text;
			if (writing || Date.now() - lastWrite < PROGRESS_WRITE_MS) return;
			run();
		},
		async flush() {
			while (writing) await writing;
			await write();
		}
	};
}

/**
 * `ai.translate` scanner. The work item is the `translations` row itself.
 * Every tick claims rows through `translation-lease.ts` instead of selecting
 * them: the claim is one atomic statement, so two workers cannot generate (and
 * bill) the same row. A worker killed after a claim leaves a stale heartbeat
 * that the next tick reclaims after 90s, and `runs < 20` stops a crash loop.
 */
export async function runTranslationJob(ctx: JobContext): Promise<void> {
	const startedAt = Date.now();
	let claimed = 0;
	let generated = 0;
	let failed = 0;
	let waiting = 0;
	let cancelled = 0;
	let deadlineHit = false;

	const outOfBudget = () => Date.now() - startedAt > RUN_BUDGET_MS;

	// Before claiming: a row that burned all 20 claims (a worker that keeps
	// dying after its claim) would otherwise match the predicate forever and
	// keep taking the first slot of every tick without ever progressing.
	const swept = await sweepTranslationCrashLoops(ctx.db);
	if (swept > 0) ctx.logger.warn(`translation sweep abandoned ${swept} crash-loop row(s)`);

	/**
	 * Rows this tick already touched. `markTranslationWaiting` and a
	 * non-terminal failure leave the row matching the claim predicate, so the
	 * batch loop must not claim them again: that would burn `runs` and starve
	 * every other row.
	 */
	const touched: string[] = [];

	while (claimed < BATCH) {
		if (outOfBudget()) {
			deadlineHit = true;
			ctx.logger.warn(`translation batch stopped at the ${RUN_BUDGET_MS}ms run budget`);
			break;
		}
		const row = await claimTranslationRow(ctx.db, [...touched]);
		if (!row) break;
		claimed += 1;
		touched.push(row.id);
		if (outOfBudget()) {
			// Claimed just as the budget closed: hand the lease straight back.
			// `runs` already moved, but nothing failed, so `attempt` must not.
			await releaseTranslation(ctx.db, row.id);
			deadlineHit = true;
			ctx.logger.warn(`translation batch stopped at the ${RUN_BUDGET_MS}ms run budget`);
			break;
		}

		if (await isTranslationCancelled(ctx.db, row.id)) {
			// Discarded while queued: stop before spending anything.
			cancelled += 1;
			continue;
		}

		const sourceType = row.sourcePostId ? 'post' : 'note';
		const sourceId = row.sourcePostId ?? row.sourceNoteId;
		if (!sourceId) {
			const { attempt, abandoned } = await failTranslationAttempt(ctx.db, row.id);
			ctx.logger.warn(
				`translation ${row.id} has no source row (attempt ${attempt}/${MAX_ATTEMPTS}` +
					`${abandoned ? ', abandoned' : ''})`
			);
			failed += 1;
			continue;
		}

		let candidate: TranslationCandidate | null = null;
		let failure: unknown = null;
		const stopHeartbeat = startHeartbeat(ctx, row.id);
		const preview = startProgressWriter(ctx, row.id);
		/**
		 * Chunk progress for this run. `generateTranslation` reports the plan
		 * (source hash, count, budget) and every finished chunk; writes are
		 * serialized so the terminal write below can await the last one.
		 */
		let plan: { sourceHash: string; total: number; maxChars: number } | null = null;
		let chunkState: TranslationProgressChunk[] = [];
		/** Terms the prompt required but the body lacks; written with the candidate. */
		let glossaryMisses: { term: string; expected: string }[] = [];
		let progressWrite: Promise<void> = Promise.resolve();
		const persistProgress = (): void => {
			if (!plan) return;
			const snapshot = {
				sourceHash: plan.sourceHash,
				total: plan.total,
				maxChars: plan.maxChars,
				done: chunkState.filter((chunk) => chunk.status === 'done').length,
				chunks: chunkState.map((chunk) => ({ ...chunk }))
			};
			progressWrite = progressWrite
				.then(async () => {
					await ctx.db
						.update(translations)
						.set({ progress: snapshot })
						.where(and(eq(translations.id, row.id), eq(translations.status, 'draft')));
				})
				.catch((caught: unknown) => {
					ctx.logger.warn(
						`translation ${row.id} progress write failed: ${sanitizeErrorText(caught)}`
					);
				});
		};
		try {
			candidate = await generateTranslation(
				{
					sourceType,
					sourceId,
					targetLang: row.targetLang,
					// A human asked for this generation, so the budget policy
					// ("manual calls stay available") must actually apply: the
					// row's job trigger is the only place that knows.
					manual: ctx.trigger === 'manual',
					// Attribution rides on the row: the process that ran the job
					// has no session, but it can still say who requested it.
					actorId: row.requestedBy ?? null,
					onProgress: preview.onProgress,
					onGlossaryMisses: (misses) => {
						glossaryMisses = misses;
					},
					// Resume state from a previous tick, plus the hooks that keep
					// it current; generateTranslation validates the plan.
					progress: row.progress,
					onPlan: ({ sourceHash, total, maxChars, prior }) => {
						plan = { sourceHash, total, maxChars };
						chunkState =
							prior?.chunks?.length === total
								? prior.chunks.map((chunk) => ({ ...chunk }))
								: Array.from({ length: total }, (_, ordinal) => ({
										ordinal,
										status: 'pending' as const
									}));
					},
					onChunk: (index, text) => {
						chunkState[index] = {
							ordinal: index,
							status: 'done',
							text,
							tokens: chunkState[index]?.tokens
						};
						persistProgress();
					}
				},
				{
					db: ctx.db as unknown as AiDeps['db'],
					getEnv: (name) => process.env[name],
					log: (message) => ctx.logger.info(message),
					timeoutMs: ATTEMPT_TIMEOUT_MS,
					streamTimeoutMs: STREAM_TIMEOUT_MS,
					maxAttempts: ATTEMPTS
				}
			);
		} catch (caught) {
			failure = caught;
		} finally {
			// Stop before the terminal write: a late beat must not resurrect a
			// lease on a row this run just finished with, and a late progress
			// frame must not overwrite the terminal state.
			stopHeartbeat();
			await progressWrite;
			await preview.flush();
		}

		if (failure !== null) {
			const message = sanitizeErrorText(failure);
			const aiError = isAiError(failure) ? failure : null;
			if (aiError && WAITING_CODES.has(aiError.code)) {
				// The stored reason paints inside the drawer's copy, so it must be
				// the message itself, not `String(error)` (which adds the class).
				// Only a provider pause/budget deserves a fresh claim budget: a
				// network failure that never clears must eventually hit the
				// crash-loop guard instead of being retried forever.
				await markTranslationWaiting(ctx.db, row.id, sanitizeErrorText(aiError.message), {
					resetRuns: aiError.code !== 'network'
				});
				waiting += 1;
				ctx.logger.info(`translation ${row.id} waiting (${aiError.code}): ${message}`);
				continue;
			}
			// A timeout, a truncated body or a non-retryable error is a real
			// failed attempt; the third one abandons the row.
			const { attempt, abandoned } = await failTranslationAttempt(ctx.db, row.id);
			failed += 1;
			ctx.logger.warn(
				`translation ${row.id} failed (attempt ${attempt}/${MAX_ATTEMPTS}` +
					`${abandoned ? ', abandoned' : ''}): ${message}`
			);
			continue;
		}

		if (await isTranslationCancelled(ctx.db, row.id)) {
			// Discarded while generating: the money is spent, the body is not ours.
			cancelled += 1;
			continue;
		}
		if (!candidate) {
			// generateTranslation either returns a candidate or throws; this
			// guard keeps a future early return from writing a null body.
			await failTranslationAttempt(ctx.db, row.id);
			failed += 1;
			continue;
		}

		const written = await ctx.db
			.update(translations)
			.set({
				title: candidate.title,
				content: candidate.content,
				summary: candidate.summary,
				contentFormat: candidate.contentFormat,
				sourceHash: candidate.sourceHash,
				model: candidate.model,
				error: null,
				// The row is complete: clear the lease, the failure counters, the
				// parked state and the streaming preview (the body supersedes it).
				// Glossary misses survive in `progress` because they describe the
				// finished body, not the run: the drawer shows which terms the model
				// ignored so a human can fix the glossary or the text.
				stage: null,
				waitingReason: null,
				heartbeatAt: null,
				progress:
					glossaryMisses.length > 0 ? { total: 0, done: 0, chunks: [], glossaryMisses } : null,
				attempt: 0,
				runs: 0,
				updatedAt: new Date()
			})
			.where(
				and(
					eq(translations.id, row.id),
					// Only a still-pending row may receive the candidate: a
					// discard (or a retry reset) that raced this write must
					// not be overwritten.
					eq(translations.status, 'draft'),
					isNull(translations.content),
					eq(translations.cancelRequested, false)
				)
			)
			.returning({ id: translations.id });
		if (written.length === 0) {
			cancelled += 1;
			continue;
		}
		generated += 1;
	}

	ctx.summary({ claimed, generated, failed, waiting, cancelled, deadlineHit });
	if (claimed > 0) {
		ctx.logger.info(
			`translation batch claimed=${claimed} generated=${generated} failed=${failed}` +
				` waiting=${waiting} cancelled=${cancelled}` +
				(deadlineHit ? ' deadline=hit' : '')
		);
	}
}

/** A cheap count for the workbench / job summary. */
export async function countPendingTranslations(ctx: JobContext): Promise<number> {
	const [row] = await ctx.db
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(translations)
		.where(
			and(
				eq(translations.status, 'draft'),
				isNull(translations.content),
				isNull(translations.error)
			)
		);
	return row?.n ?? 0;
}

import { and, asc, eq, notExists, sql } from 'drizzle-orm';
import { comments } from '../db/content/comment.schema.ts';
import { commentModerationEvents } from '../db/content/comment-moderation-event.schema.ts';
import { getOption } from '../config/options-registry.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import { resolveProviderKey, type SecretDb } from '../secrets/resolver.ts';
import { resolveProvider } from './providers.ts';
import { reviewComment } from './moderate.ts';
import type { AiDeps } from './types.ts';
import type { JobContext } from '../jobs/types.ts';

const BATCH = 5;

/**
 * `ai.comment-review` advisory job. It records an AI suggestion for pending
 * comments that have no AI event yet; `applied` is always false in v1. The
 * human queue remains the only writer of `comments.state`, so a bad model
 * verdict can never approve or reject a reader's comment.
 *
 * The job respects `comments.moderation.enabled` and the configured
 * allow/block thresholds. A comment that keeps failing is parked with a
 * conservative hold event so a poison comment cannot pin the batch (and the
 * per-tick provider billing) forever.
 */
export async function runCommentReviewJob(ctx: JobContext): Promise<void> {
	const moderation = await getOption('comments.moderation', ctx.db as unknown as AiDeps['db']);
	if (!moderation.enabled) {
		ctx.summary({ skipped: 'moderation-off' });
		return;
	}
	// Fail fast when nothing can run: without an assignment every comment in
	// the batch would burn a provider-resolution error on every tick.
	try {
		await resolveProvider(ctx.db as unknown as AiDeps['db'], 'comment_review');
	} catch (caught) {
		ctx.summary({ skipped: sanitizeErrorText(caught) });
		return;
	}
	const rows = await ctx.db
		.select({ id: comments.id })
		.from(comments)
		.where(
			and(
				eq(comments.state, 'pending'),
				eq(comments.isDeleted, false),
				notExists(
					ctx.db
						.select({ one: sql`1` })
						.from(commentModerationEvents)
						.where(
							and(
								eq(commentModerationEvents.commentId, comments.id),
								eq(commentModerationEvents.source, 'ai')
							)
						)
				)
			)
		)
		.orderBy(asc(comments.createdAt))
		.limit(BATCH);

	let reviewed = 0;
	let failed = 0;
	for (const row of rows) {
		try {
			const review = await reviewComment(
				{ commentId: row.id },
				{
					db: ctx.db as unknown as AiDeps['db'],
					getEnv: (name) => process.env[name],
					resolveKey: (provider) =>
						resolveProviderKey(ctx.db as unknown as SecretDb, provider, {
							getEnv: (name) => process.env[name]
						}),
					log: (message) => ctx.logger.info(message)
				}
			);
			const outcome =
				review.score >= moderation.thresholds.block
					? 'block'
					: review.score >= moderation.thresholds.allow
						? 'hold'
						: 'allow';
			await ctx.db.insert(commentModerationEvents).values({
				commentId: row.id,
				source: 'ai',
				model: review.model,
				score: review.score.toFixed(3),
				outcome,
				// Advisory only in v1: the operator still decides.
				applied: false,
				detail: { category: review.category, reason: review.reason }
			});
			reviewed += 1;
		} catch (caught) {
			const message = sanitizeErrorText(caught);
			ctx.logger.warn(`comment review ${row.id} failed: ${message}`);
			// Park the row: a hold event takes it out of the scan set, so a
			// permanently failing comment neither pins the batch nor re-bills
			// every tick. applied=false keeps it advisory; the operator
			// decides from the queue.
			try {
				await ctx.db.insert(commentModerationEvents).values({
					commentId: row.id,
					source: 'ai',
					model: null,
					score: null,
					outcome: 'hold',
					applied: false,
					detail: { error: true, reason: message }
				});
			} catch (insertError) {
				ctx.logger.warn(`comment review parking event failed: ${sanitizeErrorText(insertError)}`);
			}
			failed += 1;
		}
	}
	ctx.summary({ pending: rows.length, reviewed, failed });
}

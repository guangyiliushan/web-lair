import { and, eq, lt, sql, subscriptions, type JobContext } from '#jobs-sdk';

/**
 * subscriptions.sweep (email hardening E1-2): drop `pending` rows whose
 * confirmation link has been dead for 30 days.
 *
 * Data minimisation only (GDPR Art. 5(1)(e)): a never-confirmed address has no
 * consent record worth keeping. `subscribed` and `unsubscribed` rows are
 * evidence and are never touched here; the schema CHECK also makes a pending
 * row impossible to mark as unsubscribed, so deleting is the correct terminal
 * state for an abandoned signup.
 */
const PENDING_CUTOFF = sql`now() - interval '30 days'`;

export default {
	async run(ctx: JobContext): Promise<void> {
		const removed = await ctx.db
			.delete(subscriptions)
			.where(and(eq(subscriptions.status, 'pending'), lt(subscriptions.updatedAt, PENDING_CUTOFF)))
			.returning({ id: subscriptions.id });

		ctx.summary({ pending: removed.length });
		ctx.logger.info(`swept pending subscriptions=${removed.length}`);
	}
};

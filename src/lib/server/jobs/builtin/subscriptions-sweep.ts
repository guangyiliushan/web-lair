import { and, eq, lt, sql, subscriptions, type JobContext } from '#jobs-sdk';

/**
 * subscriptions.sweep (email hardening E1-2): drop `pending` rows whose
 * confirmation link has been dead for 30 days.
 *
 * Data minimisation only (GDPR Art. 5(1)(e)): a never-confirmed address has no
 * consent record worth keeping. `subscribed` and `unsubscribed` rows are
 * evidence and are never touched here. A pending row is deleted rather than
 * marked unsubscribed: the CHECK requires `verified_at` on non-pending rows,
 * and fabricating a verification time for a never-confirmed address would lie
 * in the audit record.
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

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Email suppression list (email hardening E2-1).
 *
 * Orthogonal to `subscriptions`: an opt-out or a hard bounce must be remembered
 * even when the subscription row itself is gone (pending rows are deleted on
 * unsubscribe / swept after 30 days). Only a keyed hash of the address is
 * stored, so the table can outlive the plaintext record.
 */
export const emailSuppressions = pgTable(
	'email_suppressions',
	{
		emailHash: text('email_hash').primaryKey(),
		reason: text('reason').notNull(),
		source: text('source').notNull().default(''),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		check(
			'email_suppressions_reason_check',
			sql`${table.reason} in ('unsubscribed', 'bounced', 'complained')`
		)
	]
);

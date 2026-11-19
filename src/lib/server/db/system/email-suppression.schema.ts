import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Email suppression list.
 *
 * Orthogonal to `subscriptions`: an opt-out or a hard bounce must be remembered
 * even when the subscription row itself is gone (pending rows are deleted on
 * unsubscribe / swept after 30 days). Only a keyed hash of the address is
 * stored, so the table can outlive the plaintext record.
 *
 * `key_version` records which derivation produced `email_hash`. Version 1 is
 * the original single-key scheme (`HMAC(SUPPRESSION_HMAC_KEY, email)`); every
 * later version derives its key from the same master
 * (`HMAC(master, 'wl:suppression:key:v<N>')`), so old rows stay verifiable
 * after a rotation without keeping a second secret in the environment.
 */
export const emailSuppressions = pgTable(
	'email_suppressions',
	{
		emailHash: text('email_hash').primaryKey(),
		reason: text('reason').notNull(),
		source: text('source').notNull().default(''),
		keyVersion: smallint('key_version').notNull().default(1),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		check(
			'email_suppressions_reason_check',
			sql`${table.reason} in ('unsubscribed', 'bounced', 'complained')`
		),
		check('email_suppressions_key_version_check', sql`${table.keyVersion} >= 1`)
	]
);

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** Double opt-in subscription (platform §D.2): pending → subscribed → unsubscribed. */
export const subscriptions = pgTable(
	'subscriptions',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		email: text('email').notNull(),
		status: text('status').notNull().default('pending'),
		lang: text('lang').notNull().default('en'),
		source: text('source'),
		/**
		 * Consent text version (E2-2). Written from a code constant; nullable so
		 * rows created before the column existed can be marked `legacy`.
		 */
		consentVersion: text('consent_version'),
		/**
		 * Random 32-byte nonce (base64url, 43 chars) for the current token (F-13).
		 * The mailed token is `HMAC-SHA256(SUBSCRIBE_TOKEN_SECRET, nonce)`, so the
		 * service can re-derive the link without storing a usable credential:
		 * a database dump holds only the nonce (useless without the env secret)
		 * and the SHA-256 lookup hash.
		 */
		tokenNonce: text('token_nonce').notNull(),
		/**
		 * SHA-256 of the current derived token (E2-3, F-13). This is the only
		 * lookup column for confirm/unsubscribe links; the plaintext `token`
		 * column was dropped once the derived-token path landed.
		 */
		tokenHash: text('token_hash').notNull(),
		verifiedAt: timestamp('verified_at', { withTimezone: true }),
		unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('subscriptions_email_uniq').on(table.email),
		uniqueIndex('subscriptions_token_nonce_uniq').on(table.tokenNonce),
		uniqueIndex('subscriptions_token_hash_uniq').on(table.tokenHash),
		check('subscriptions_token_nonce_len_check', sql`char_length(${table.tokenNonce}) = 43`),
		check(
			'subscriptions_status_check',
			sql`${table.status} in ('pending', 'subscribed', 'unsubscribed')`
		),
		check('subscriptions_lang_check', sql`${table.lang} in ('en', 'zh-cn', 'ja')`),
		// Monotonic timestamps: pending => verified_at null; non-pending => verified_at set;
		// unsubscribed => unsubscribed_at set (history may keep it after resubscribe).
		check(
			'subscriptions_verified_at_check',
			sql`(${table.status} = 'pending') = (${table.verifiedAt} is null)`
		),
		check(
			'subscriptions_unsubscribed_at_check',
			sql`${table.status} <> 'unsubscribed' or ${table.unsubscribedAt} is not null`
		)
	]
);

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
		token: text('token').notNull(),
		verifiedAt: timestamp('verified_at', { withTimezone: true }),
		unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('subscriptions_email_uniq').on(table.email),
		uniqueIndex('subscriptions_token_uniq').on(table.token),
		check(
			'subscriptions_status_check',
			sql`${table.status} in ('pending', 'subscribed', 'unsubscribed')`
		),
		check('subscriptions_lang_check', sql`${table.lang} in ('en', 'zh-cn', 'ja')`),
		// status transitions require matching timestamps.
		check(
			'subscriptions_verified_at_check',
			sql`(${table.status} = 'subscribed') = (${table.verifiedAt} is not null)`
		),
		check(
			'subscriptions_unsubscribed_at_check',
			sql`(${table.status} = 'unsubscribed') = (${table.unsubscribedAt} is not null)`
		)
	]
);

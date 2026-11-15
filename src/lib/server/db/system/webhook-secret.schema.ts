import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { webhooks } from './webhook.schema.ts';

/**
 * Webhook signing secrets, encrypted (W2.3/W2.6, decisions T1-A / T2-A).
 *
 * The current value is used for every new delivery. During a rotation the
 * previous value stays verifiable until `previousExpiresAt` (the retry window
 * of deliveries already in flight, plus one release cycle), so a receiver can
 * still validate a request signed before the operator rotated. Both are
 * envelopes from the same crypto module as the AI keys, but the lifecycle and
 * the display rule (show-once) differ - hence a separate table.
 *
 * `previous*` is an all-or-nothing triplet: a half-written rotation would
 * either drop the grace window or keep an unverifiable value forever.
 */
export const webhookSecrets = pgTable(
	'webhook_secrets',
	{
		webhookId: uuid('webhook_id')
			.primaryKey()
			.references(() => webhooks.id, { onDelete: 'cascade' }),
		ciphertext: text('ciphertext').notNull(),
		hint: text('hint').notNull(),
		keyVersion: integer('key_version').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		/** Grace-window value: verifiable until `previousExpiresAt`, never displayed. */
		previousCiphertext: text('previous_ciphertext'),
		previousKeyVersion: integer('previous_key_version'),
		previousExpiresAt: timestamp('previous_expires_at', { withTimezone: true }),
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		check('webhook_secrets_key_version_check', sql`${table.keyVersion} > 0`),
		check('webhook_secrets_ciphertext_check', sql`length(${table.ciphertext}) > 0`),
		check('webhook_secrets_hint_check', sql`length(${table.hint}) > 0`),
		check(
			'webhook_secrets_previous_pair_check',
			sql`(${table.previousCiphertext} is null) = (${table.previousExpiresAt} is null) and (${table.previousCiphertext} is null) = (${table.previousKeyVersion} is null)`
		),
		check(
			'webhook_secrets_previous_key_version_check',
			sql`${table.previousKeyVersion} is null or ${table.previousKeyVersion} > 0`
		)
	]
);

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';

/**
 * External storage credentials, encrypted at rest (W7.6, decisions Q3/Q15).
 *
 * The site has exactly ONE external provider slot (`storage.provider.driver =
 * 's3'`), so this is a singleton row keyed `'s3'` — no id juggling, and a
 * stray second row is impossible. Both halves of the pair are envelopes from
 * `secrets/crypto.ts` (AES-256-GCM, row-bound AAD), and the `*_hint` columns
 * are the only fragments the admin UI ever renders.
 *
 * Read order at runtime: this row > env (`STORAGE_S3_*`). A row that cannot be
 * decrypted is terminal — there is NO env fallback, because a wrong master key
 * must be visible instead of silently using a stale credential (W2/D0-C).
 *
 * Why a table rather than an option: options are loaded wholesale and rendered
 * by several pages; ciphertext there would leak into page data and `select *`.
 */
export const STORAGE_SECRET_ID = 's3';

export const storageSecrets = pgTable(
	'storage_secrets',
	{
		id: text('id').primaryKey(),
		accessKeyCiphertext: text('access_key_ciphertext').notNull(),
		accessKeyHint: text('access_key_hint').notNull(),
		accessKeyKeyVersion: integer('access_key_key_version').notNull(),
		secretCiphertext: text('secret_ciphertext').notNull(),
		secretHint: text('secret_hint').notNull(),
		secretKeyVersion: integer('secret_key_version').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		check('storage_secrets_id_check', sql`${table.id} = 's3'`),
		check('storage_secrets_access_key_version_check', sql`${table.accessKeyKeyVersion} > 0`),
		check('storage_secrets_secret_key_version_check', sql`${table.secretKeyVersion} > 0`),
		check(
			'storage_secrets_ciphertext_check',
			sql`length(${table.accessKeyCiphertext}) > 0 and length(${table.secretCiphertext}) > 0`
		),
		check(
			'storage_secrets_hint_check',
			sql`length(${table.accessKeyHint}) > 0 and length(${table.secretHint}) > 0`
		)
	]
);

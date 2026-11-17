import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';

/**
 * External storage credentials, encrypted at rest: one singleton row keyed `'s3'` (the site has
 * exactly one provider slot), both halves AES-256-GCM envelopes from `secrets/crypto.ts`, and
 * `*_hint` is all the admin UI renders.
 * Read order is row then env (`STORAGE_S3_*`), and an undecryptable row never falls back to env -
 * see `storage-credentials.test.ts › "never falls back to env when the row cannot be decrypted"`.
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

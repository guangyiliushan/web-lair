import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { aiProviders } from './ai-provider.schema.ts';

/**
 * Runtime AI provider credentials (W2.3, decisions D0-C / T1-A).
 *
 * One row per provider that has an app-managed key. `ciphertext` is the
 * `v1:<keyVersion>:<iv>:<tag>:<ct>` envelope from
 * `src/lib/server/secrets/crypto.ts`; `hint` is the display fragment
 * (`sk-…Abcd`) and is the only value the admin UI ever sees. `api_key_env` on
 * `ai_providers` stays as the bootstrap fallback and the UI shows which source
 * answered.
 *
 * A dedicated table, not an `options` row: options are loaded wholesale and
 * rendered by several pages, so ciphertext there would leak into page data,
 * logs and `select *` output.
 */
export const aiProviderSecrets = pgTable(
	'ai_provider_secrets',
	{
		providerId: uuid('provider_id')
			.primaryKey()
			.references(() => aiProviders.id, { onDelete: 'cascade' }),
		ciphertext: text('ciphertext').notNull(),
		hint: text('hint').notNull(),
		keyVersion: integer('key_version').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		// `user.id` is text in the generated auth schema; keep the audit link
		// optional so deleting an admin never deletes the credential.
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		check('ai_provider_secrets_key_version_check', sql`${table.keyVersion} > 0`),
		check('ai_provider_secrets_ciphertext_check', sql`length(${table.ciphertext}) > 0`),
		check('ai_provider_secrets_hint_check', sql`length(${table.hint}) > 0`)
	]
);

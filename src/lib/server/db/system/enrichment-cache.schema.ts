import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';

export const enrichmentCache = pgTable(
	'enrichment_cache',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		provider: varchar('provider', { length: 64 }).notNull(),
		externalId: varchar('external_id', { length: 256 }).notNull(),
		url: text('url').notNull(),
		locale: varchar('locale', { length: 8 }).notNull().default(''),
		normalized: jsonb('normalized').$type<Record<string, unknown>>().notNull(),
		raw: jsonb('raw'),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		failureCount: integer('failure_count').notNull().default(0),
		lastError: text('last_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('enrichment_cache_provider_external_id_locale_uniq').on(
			table.provider,
			table.externalId,
			table.locale
		),
		index('enrichment_cache_expires_at_idx').on(table.expiresAt)
	]
);

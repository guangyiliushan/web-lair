import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * AI summary records (renamed from ai_summaries in P1, ledger §9.20.3/§4.5):
 * one row per (ref, lang); NULLS NOT DISTINCT so a NULL lang is unique too.
 */
export const summaries = pgTable(
	'summaries',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		hash: text('hash').notNull(),
		summary: text('summary').notNull(),
		refId: uuid('ref_id').notNull(),
		lang: text('lang')
	},
	(table) => [unique('summaries_ref_lang_uniq').on(table.refId, table.lang).nullsNotDistinct()]
);

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Slug history for 301 fallbacks (ledger §9.16/§11-A4): resolves an old
 * (type, lang, slug) to its current target.
 */
export const slugTrackers = pgTable(
	'slug_trackers',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		slug: text('slug').notNull(),
		type: text('type').notNull(),
		lang: text('lang').notNull().default('en'),
		targetId: uuid('target_id').notNull()
	},
	(table) => [
		index('slug_trackers_type_lang_slug_idx').on(table.type, table.lang, table.slug),
		index('slug_trackers_type_target_idx').on(table.type, table.targetId)
	]
);

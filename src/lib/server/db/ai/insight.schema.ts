import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/** AI insight records (renamed from ai_insights in P1, ledger §9.20.3/§4.5). */
export const insights = pgTable(
	'insights',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		refId: uuid('ref_id').notNull(),
		lang: text('lang').notNull(),
		hash: text('hash').notNull(),
		content: text('content').notNull(),
		isTranslation: boolean('is_translation').notNull().default(false),
		sourceInsightsId: uuid('source_insights_id').references((): AnyPgColumn => insights.id, {
			onDelete: 'set null'
		}),
		sourceLang: text('source_lang'),
		modelInfo: jsonb('model_info').$type<Record<string, unknown> | null>()
	},
	(table) => [
		uniqueIndex('insights_ref_lang_uniq').on(table.refId, table.lang),
		// §4.6: SET NULL self-FK needs a leading index.
		index('insights_source_insights_idx').on(table.sourceInsightsId)
	]
);

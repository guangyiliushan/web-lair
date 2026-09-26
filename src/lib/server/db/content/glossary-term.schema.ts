import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * Glossary (AI-1, ledger §14.3): translation term pairs the pipeline injects
 * into prompts and verifies against afterwards. `captured` rows are
 * candidates captured from misses and start disabled; `manual` rows are
 * curated by the owner.
 */
export const glossaryTerms = pgTable(
	'glossary_terms',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		sourceLang: text('source_lang').notNull(),
		term: text('term').notNull(),
		targetLang: text('target_lang').notNull(),
		translation: text('translation').notNull(),
		note: text('note'),
		caseSensitive: boolean('case_sensitive').notNull().default(false),
		enabled: boolean('enabled').notNull().default(true),
		origin: text('origin').notNull()
	},
	(table) => [
		check('glossary_terms_source_lang_check', sql`${table.sourceLang} in ('en', 'zh-cn', 'ja')`),
		check('glossary_terms_target_lang_check', sql`${table.targetLang} in ('en', 'zh-cn', 'ja')`),
		check('glossary_terms_origin_check', sql`${table.origin} in ('manual', 'captured')`),
		uniqueIndex('glossary_terms_uniq').on(table.sourceLang, table.term, table.targetLang),
		index('glossary_terms_lookup_idx').on(table.sourceLang, table.targetLang, table.enabled)
	]
);

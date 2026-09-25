import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

export const searchDocuments = pgTable(
	'search_documents',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		refType: text('ref_type').notNull(),
		refId: uuid('ref_id').notNull(),
		lang: text('lang').notNull(),
		sourceHash: text('source_hash').notNull().default(''),
		title: text('title').notNull(),
		searchText: text('search_text').notNull(),
		terms: text('terms')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		titleTermFreq: jsonb('title_term_freq')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		bodyTermFreq: jsonb('body_term_freq')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		titleLength: integer('title_length').notNull().default(0),
		bodyLength: integer('body_length').notNull().default(0),
		slug: text('slug'),
		nid: integer('nid'),
		isPublished: boolean('is_published').notNull().default(true),
		publicAt: timestamp('public_at', { withTimezone: true }),
		hasPassword: boolean('has_password').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date())
	},
	(table) => [
		uniqueIndex('search_documents_ref_lang_uniq').on(table.refType, table.refId, table.lang),
		index('search_documents_published_idx').on(table.isPublished, table.publicAt),
		index('search_documents_lang_idx').on(table.lang)
	]
);

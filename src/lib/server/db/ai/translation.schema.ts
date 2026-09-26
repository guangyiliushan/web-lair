import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { posts } from '../content/post.schema';

/**
 * Translation workbench (reshaped from ai_translations in P1, ledger §9.17/
 * §11-C3): candidates for a (source post, target language) pair; at most one
 * non-discarded candidate per pair (partial unique).
 */
export const translations = pgTable(
	'translations',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		sourcePostId: uuid('source_post_id')
			.notNull()
			.references(() => posts.id, { onDelete: 'cascade' }),
		targetLang: text('target_lang').notNull(),
		title: text('title').notNull(),
		content: text('content'),
		summary: text('summary'),
		contentFormat: text('content_format').notNull().default('markdown'),
		origin: text('origin').notNull(),
		model: text('model'),
		sourceHash: text('source_hash'),
		status: text('status').notNull().default('draft')
	},
	(table) => [
		check('translations_target_lang_check', sql`${table.targetLang} in ('en', 'zh-cn', 'ja')`),
		check('translations_origin_check', sql`${table.origin} in ('human', 'ai', 'machine')`),
		check('translations_status_check', sql`${table.status} in ('draft', 'accepted', 'discarded')`),
		uniqueIndex('translations_active_uniq')
			.on(table.sourcePostId, table.targetLang)
			.where(sql`${table.status} <> 'discarded'`),
		// Plain leading index: the partial unique above cannot serve the FK's
		// referential checks for discarded rows (P1.1 review).
		index('translations_source_idx').on(table.sourcePostId)
	]
);

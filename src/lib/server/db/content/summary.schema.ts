import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { posts } from './post.schema.ts';

/**
 * AI summary ledger: one row per generated candidate = (post, lang,
 * source_hash). `posts.summary` stays the content source of truth - this
 * table is the generation record (record vs source-of-truth separation).
 * Adoption writes posts.summary and stamps `adopted_at`; at most one
 * adopted row per (post, lang). Unadopted rows are pruned to the latest 5
 * per (post, lang) by a maintenance task.
 */
export const summaries = pgTable(
	'summaries',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		postId: uuid('post_id')
			.notNull()
			.references(() => posts.id, { onDelete: 'cascade' }),
		lang: text('lang').notNull(),
		sourceHash: text('source_hash').notNull(),
		summary: text('summary').notNull(),
		model: text('model'),
		adoptedAt: timestamp('adopted_at', { withTimezone: true })
	},
	(table) => [
		check('summaries_lang_check', sql`${table.lang} in ('en', 'zh-cn', 'ja')`),
		uniqueIndex('summaries_post_lang_hash_uniq').on(table.postId, table.lang, table.sourceHash),
		uniqueIndex('summaries_adopted_uniq')
			.on(table.postId, table.lang)
			.where(sql`${table.adoptedAt} is not null`)
	]
);

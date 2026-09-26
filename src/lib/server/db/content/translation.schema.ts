import { sql } from 'drizzle-orm';
import {
	check,
	index,
	pgTable,
	numeric,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import { posts } from './post.schema';

/**
 * Translation workbench (AI-1 patch, ledger §14.3): one row per generation
 * attempt. `accepted` = written into the target post; `discarded` = kept for
 * the record. At most one in-flight draft per (source post, target lang) -
 * the P1 predicate `<> 'discarded'` would block re-translation after a
 * discard, so the partial unique is scoped to `status = 'draft'`.
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
		status: text('status').notNull().default('draft'),
		score: numeric('score'),
		reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		targetPostId: uuid('target_post_id').references(() => posts.id, { onDelete: 'set null' }),
		error: text('error')
	},
	(table) => [
		check('translations_target_lang_check', sql`${table.targetLang} in ('en', 'zh-cn', 'ja')`),
		check('translations_origin_check', sql`${table.origin} in ('human', 'ai', 'machine')`),
		check('translations_status_check', sql`${table.status} in ('draft', 'accepted', 'discarded')`),
		uniqueIndex('translations_draft_uniq')
			.on(table.sourcePostId, table.targetLang)
			.where(sql`${table.status} = 'draft'`),
		// Plain leading index: the partial unique above cannot serve the FK's
		// referential checks outside its predicate (P1.1 review / AI-1).
		index('translations_source_idx').on(table.sourcePostId),
		index('translations_target_post_idx')
			.on(table.targetPostId)
			.where(sql`${table.targetPostId} is not null`),
		index('translations_reviewed_by_idx')
			.on(table.reviewedBy)
			.where(sql`${table.reviewedBy} is not null`)
	]
);

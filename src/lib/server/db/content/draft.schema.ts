import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import { categories } from './category.schema';

/**
 * Drafts are the unpublished working copy of a post (edit isolation, ledger
 * §9.2/§9.3/§9.10): one row per target (`unique(ref_type, ref_id)` partial),
 * upserted by autosave/save, published by the publish transaction, discarded
 * explicitly. `ref_id` stays polymorphic (posts/notes/pages); `author` points
 * at the auth table and remains text (§9.6 exception).
 */
export const drafts = pgTable(
	'drafts',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		refType: text('ref_type').notNull(),
		refId: uuid('ref_id'),
		title: text('title').notNull().default(''),
		slug: text('slug'),
		categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
		tags: text('tags')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		content: text('content'),
		contentFormat: text('content_format').notNull().default('markdown'),
		summary: text('summary'),
		version: integer('version').notNull().default(1),
		baseVersion: integer('base_version'),
		author: text('author').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		uniqueIndex('drafts_ref_uniq')
			.on(table.refType, table.refId)
			.where(sql`${table.refId} is not null`),
		index('drafts_updated_at_idx').on(table.updatedAt),
		// §11-A2: SET NULL FKs need leading (partial) indexes (P1.1 review).
		index('drafts_author_idx')
			.on(table.author)
			.where(sql`${table.author} is not null`),
		index('drafts_category_idx')
			.on(table.categoryId)
			.where(sql`${table.categoryId} is not null`)
	]
);

import { sql } from 'drizzle-orm';
import {
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { posts } from './post.schema';

/**
 * Tags are a real entity since P1 (ledger §9.12): the posts.tags array
 * retired, `post_tags` is the single source of truth for the relation.
 */
export const tags = pgTable(
	'tags',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [uniqueIndex('tags_slug_uniq').on(table.slug)]
);

export const postTags = pgTable(
	'post_tags',
	{
		postId: uuid('post_id')
			.notNull()
			.references(() => posts.id, { onDelete: 'cascade' }),
		tagId: uuid('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' })
	},
	(table) => [
		primaryKey({ columns: [table.postId, table.tagId] }),
		index('post_tags_tag_idx').on(table.tagId, table.postId)
	]
);

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import { posts } from './post.schema';

/**
 * Publish-time snapshots only (ledger §9.3): every publish appends one
 * revision; the prune job keeps the newest 20 per post. `author` points at
 * the auth table and remains text (§9.6 exception).
 */
export const postRevisions = pgTable(
	'post_revisions',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		postId: uuid('post_id')
			.notNull()
			.references(() => posts.id, { onDelete: 'cascade' }),
		version: integer('version').notNull(),
		title: text('title').notNull(),
		content: text('content'),
		summary: text('summary'),
		source: text('source').notNull(),
		author: text('author').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		uniqueIndex('post_revisions_post_version_uniq').on(table.postId, table.version),
		check('post_revisions_source_check', sql`${table.source} in ('publish')`)
	]
);

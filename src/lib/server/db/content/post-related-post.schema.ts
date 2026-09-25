import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { posts } from './post.schema';

export const postRelatedPosts = pgTable(
	'post_related_posts',
	{
		postId: uuid('post_id')
			.notNull()
			.references((): AnyPgColumn => posts.id, { onDelete: 'cascade' }),
		relatedPostId: uuid('related_post_id')
			.notNull()
			.references((): AnyPgColumn => posts.id, { onDelete: 'cascade' }),
		position: integer('position').notNull().default(0)
	},
	(table) => [
		primaryKey({ columns: [table.postId, table.relatedPostId] }),
		index('post_related_posts_related_idx').on(table.relatedPostId)
	]
);

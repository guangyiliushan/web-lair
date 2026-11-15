import { sql } from 'drizzle-orm';
import {
	check,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { posts } from './post.schema.ts';

/**
 * Tags are a real entity since P1 (ledger §9.12): the posts.tags array
 * retired, `post_tags` is the single source of truth for the relation.
 *
 * Tags are language-neutral by ruling (§9.18.4) and deliberately ASCII-only
 * (2026-10-23): they are created from free text on three write paths
 * (post publish, media library, seed), so the DB constraint — not the
 * callers — has to be the guarantee. `slug` stays URL-safe: the old
 * `tagSlug` kept `/`, which produced unroutable `/posts/tags/ui/ux`.
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
	(table) => [
		uniqueIndex('tags_slug_uniq').on(table.slug),
		check('tags_name_ascii_check', sql`${table.name} ~ '^[A-Za-z0-9 .,+#&''()/_-]+$'`),
		check(
			'tags_name_shape_check',
			sql`btrim(${table.name}) = ${table.name} and length(${table.name}) between 1 and 40`
		),
		check('tags_slug_shape_check', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._+~-]*$'`)
	]
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

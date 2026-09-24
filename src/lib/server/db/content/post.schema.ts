import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { categories } from './category.schema';

export const posts = pgTable(
	'posts',
	{
		id: text('id').primaryKey().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		title: text('title').notNull(),
		slug: text('slug').notNull(),
		text: text('text'),
		content: text('content'),
		contentFormat: text('content_format').notNull(),
		summary: text('summary'),
		images: jsonb('images').$type<unknown[]>(),
		meta: jsonb('meta').$type<Record<string, unknown>>(),
		tags: text('tags')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		modifiedAt: timestamp('modified_at', { withTimezone: true }),
		categoryId: text('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'restrict' }),
		copyright: boolean('copyright').notNull().default(true),
		isPublished: boolean('is_published').notNull().default(true),
		readCount: integer('read_count').notNull().default(0),
		likeCount: integer('like_count').notNull().default(0),
		pinAt: timestamp('pin_at', { withTimezone: true }),
		pinOrder: integer('pin_order')
	},
	(table) => [
		uniqueIndex('posts_slug_uniq').on(table.slug),
		index('posts_modified_at_idx').on(table.modifiedAt),
		index('posts_created_at_idx').on(table.createdAt),
		index('posts_category_id_idx').on(table.categoryId),
		index('posts_published_created_at_idx')
			.on(table.isPublished, table.pinAt.desc().nullsLast(), table.createdAt.desc()),
		index('posts_category_published_created_idx')
			.on(
				table.categoryId,
				table.isPublished,
				table.pinAt.desc().nullsLast(),
				table.createdAt.desc()
			),
		index('posts_tags_gin_idx').using('gin', table.tags)
	]
);

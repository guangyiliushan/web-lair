import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { categories } from './category.schema';

/**
 * Posts are multi-language (ledger §9.16): `lang` + `translation_group` +
 * `unique(lang, slug)` + `unique(translation_group, lang)`; the default
 * language is `en`. Visibility is a status machine (`§9.1`) with a single
 * `published_at` (scheduling = future value, read side judges lazily).
 */
export const posts = pgTable(
	'posts',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		title: text('title').notNull(),
		slug: text('slug').notNull(),
		content: text('content'),
		contentFormat: text('content_format').notNull().default('markdown'),
		summary: text('summary'),
		images: jsonb('images').$type<string[] | null>(),
		meta: jsonb('meta').$type<Record<string, unknown> | null>(),
		status: text('status').notNull().default('draft'),
		publishedAt: timestamp('published_at', { withTimezone: true }),
		version: integer('version').notNull().default(0),
		lang: text('lang').notNull().default('en'),
		translationGroup: uuid('translation_group')
			.notNull()
			.default(sql`uuidv7()`),
		translatedFromPostId: uuid('translated_from_post_id').references((): AnyPgColumn => posts.id, {
			onDelete: 'set null'
		}),
		translationOrigin: text('translation_origin'),
		categoryId: uuid('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'restrict' }),
		copyright: boolean('copyright').notNull().default(true),
		readCount: integer('read_count').notNull().default(0),
		likeCount: integer('like_count').notNull().default(0),
		pinAt: timestamp('pin_at', { withTimezone: true })
	},
	(table) => [
		check(
			'posts_status_check',
			sql`${table.status} in ('draft', 'scheduled', 'published', 'trash')`
		),
		check('posts_content_format_check', sql`${table.contentFormat} in ('markdown')`),
		check('posts_lang_check', sql`${table.lang} in ('en', 'zh-cn', 'ja')`),
		check(
			'posts_translation_origin_check',
			sql`${table.translationOrigin} in ('human', 'ai', 'machine')`
		),
		uniqueIndex('posts_lang_slug_uniq').on(table.lang, table.slug),
		uniqueIndex('posts_translation_group_lang_uniq').on(table.translationGroup, table.lang),
		index('posts_updated_at_idx').on(table.updatedAt),
		index('posts_created_at_idx').on(table.createdAt),
		index('posts_category_id_idx').on(table.categoryId),
		// §11-A1: front-end lists filter by language first.
		index('posts_status_pin_published_idx').on(
			table.lang,
			table.status,
			table.pinAt.desc().nullsLast(),
			table.publishedAt.desc()
		),
		index('posts_category_status_published_idx').on(
			table.categoryId,
			table.lang,
			table.status,
			table.pinAt.desc().nullsLast(),
			table.publishedAt.desc()
		)
	]
);

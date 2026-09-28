import { sql } from 'drizzle-orm';
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
import type { LocalizedMarkdown, LocalizedText } from './localized';

export type { LocalizedMarkdown, LocalizedText, PageLocale } from './localized';

/**
 * Page registry (pages line P0): md rows drive `(site)/[slug]`; rows without
 * content are explicit code-route registrations. The title/content fall back
 * current -> en -> any locale in the service layer.
 */
export const pages = pgTable(
	'pages',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		slug: text('slug').notNull(),
		title: jsonb('title').$type<LocalizedText>().notNull(),
		description: jsonb('description').$type<LocalizedText>(),
		icon: text('icon'),
		externalUrl: text('external_url'),
		status: text('status').notNull().default('visible'),
		sortOrder: integer('sort_order').notNull().default(1),
		isDefault: boolean('is_default').notNull().default(false),
		content: jsonb('content').$type<LocalizedMarkdown>(),
		contentFormat: text('content_format').notNull()
	},
	(table) => [
		uniqueIndex('pages_slug_uniq').on(table.slug),
		index('pages_sort_order_idx').on(table.sortOrder),
		check('pages_status_check', sql`${table.status} in ('visible', 'hidden')`),
		check(
			'pages_external_url_check',
			sql`${table.externalUrl} is null or ${table.externalUrl} ~ '^https?://'`
		),
		check('pages_title_object_check', sql`jsonb_typeof(${table.title}) = 'object'`),
		check(
			'pages_description_object_check',
			sql`${table.description} is null or jsonb_typeof(${table.description}) = 'object'`
		),
		check(
			'pages_content_object_check',
			sql`${table.content} is null or jsonb_typeof(${table.content}) = 'object'`
		),
		check('pages_content_format_check', sql`${table.contentFormat} in ('markdown')`)
	]
);

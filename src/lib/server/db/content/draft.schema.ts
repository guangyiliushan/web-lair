import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { categories } from './category.schema.ts';
import type { LocalizedMarkdown, LocalizedText } from './localized.ts';
import type { PostDraftPayload } from './post-provenance.ts';
import { topics } from './topic.schema.ts';

/**
 * Drafts are the unpublished working copy of a post (edit isolation): one
 * row per target (`unique(ref_type, ref_id)` partial), upserted by
 * autosave/save, published by the publish transaction, discarded explicitly.
 * `ref_id` stays polymorphic (posts/notes/pages); `author` points at the
 * auth table and remains text.
 */
/** Draft ref_type whitelist. */
export const DRAFT_REF_TYPES = ['post', 'page', 'note'] as const;

/** Page draft payload: the three-locale editing surface of an md page draft
 * ({title, description, content}); the slug keeps the shared drafts.slug
 * column. */
export interface PageDraftPayload {
	title: LocalizedText;
	description: LocalizedText | null;
	content: LocalizedMarkdown;
}

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
		author: text('author').references(() => user.id, { onDelete: 'set null' }),
		// Union columns so a note draft carries the diary metadata set; publish
		// moves them onto the notes row.
		topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
		mood: text('mood'),
		weatherCode: smallint('weather_code'),
		temperatureC: numeric('temperature_c', { precision: 4, scale: 1 }),
		coordinates: jsonb('coordinates').$type<{
			latitude: number;
			longitude: number;
		} | null>(),
		location: text('location'),
		// Page drafts stage their three-locale editing surface here; publish
		// copies it onto the pages row.
		payload: jsonb('payload').$type<PageDraftPayload | PostDraftPayload>()
	},
	(table) => [
		uniqueIndex('drafts_ref_uniq')
			.on(table.refType, table.refId)
			.where(sql`${table.refId} is not null`),
		index('drafts_updated_at_idx').on(table.updatedAt),
		// SET NULL FKs need leading (partial) indexes.
		index('drafts_author_idx')
			.on(table.author)
			.where(sql`${table.author} is not null`),
		index('drafts_category_idx')
			.on(table.categoryId)
			.where(sql`${table.categoryId} is not null`),
		check('drafts_ref_type_check', sql`${table.refType} in ('post', 'page', 'note')`),
		check(
			'drafts_payload_object_check',
			sql`${table.payload} is null or jsonb_typeof(${table.payload}) = 'object'`
		),
		// The topic_id SET NULL FK needs a leading (partial) index.
		index('drafts_topic_idx')
			.on(table.topicId)
			.where(sql`${table.topicId} is not null`)
	]
);

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
import { topics } from './topic.schema';

export const notes = pgTable(
	'notes',
	{
		id: text('id').primaryKey().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		nid: integer('nid').notNull().generatedByDefaultAsIdentity(),
		title: text('title'),
		slug: text('slug'),
		text: text('text'),
		content: text('content'),
		contentFormat: text('content_format').notNull(),
		images: jsonb('images').$type<unknown[]>(),
		meta: jsonb('meta').$type<Record<string, unknown>>(),
		isPublished: boolean('is_published').notNull().default(true),
		password: text('password'),
		publicAt: timestamp('public_at', { withTimezone: true }),
		mood: text('mood'),
		weather: text('weather'),
		bookmark: boolean('bookmark').notNull().default(false),
		coordinates: jsonb('coordinates').$type<{
			latitude: number;
			longitude: number;
		} | null>(),
		location: text('location'),
		readCount: integer('read_count').notNull().default(0),
		likeCount: integer('like_count').notNull().default(0),
		topicId: text('topic_id').references(() => topics.id, {
			onDelete: 'set null'
		}),
		modifiedAt: timestamp('modified_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('notes_nid_uniq').on(table.nid),
		uniqueIndex('notes_slug_uniq')
			.on(table.slug)
			.where(sql`${table.slug} is not null`),
		index('notes_nid_desc_idx').on(table.nid),
		index('notes_modified_at_idx').on(table.modifiedAt),
		index('notes_created_at_idx').on(table.createdAt),
		index('notes_topic_id_idx').on(table.topicId),
		index('notes_published_public_created_idx')
			.on(table.isPublished, table.createdAt.desc(), table.publicAt)
	]
);

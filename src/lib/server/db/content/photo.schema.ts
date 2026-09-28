import { sql } from 'drizzle-orm';
import {
	bigint,
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
import { files } from './file.schema';
import { tags } from './tag.schema';

export type LocalizedText = Partial<Record<'en' | 'zh-cn' | 'ja', string>>;

/** Photo gallery entity (storage line §3.3): 1:1 with a files row. */
export const photos = pgTable(
	'photos',
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
		fileId: uuid('file_id')
			.notNull()
			.references(() => files.id, { onDelete: 'no action' }),
		slug: text('slug').notNull(),
		title: jsonb('title').$type<LocalizedText>(),
		description: jsonb('description').$type<LocalizedText>(),
		takenAt: timestamp('taken_at', { withTimezone: true }),
		cameraMake: text('camera_make'),
		cameraModel: text('camera_model'),
		lensModel: text('lens_model'),
		fNumber: text('f_number'),
		focalLengthMm: text('focal_length_mm'),
		exposureTimeS: text('exposure_time_s'),
		iso: integer('iso'),
		latitude: text('latitude'),
		longitude: text('longitude'),
		altitudeM: text('altitude_m'),
		exif: jsonb('exif').$type<Record<string, unknown>>(),
		isVisible: boolean('is_visible').notNull().default(true)
	},
	(table) => [
		uniqueIndex('photos_slug_uniq').on(table.slug),
		uniqueIndex('photos_file_id_uniq').on(table.fileId),
		index('photos_visible_taken_idx').on(table.isVisible, table.takenAt),
		check('photos_coords_check', sql`(${table.latitude} is null) = (${table.longitude} is null)`),
		check(
			'photos_title_shape_check',
			sql`${table.title} is null or jsonb_typeof(${table.title}) = 'object'`
		),
		check(
			'photos_description_shape_check',
			sql`${table.description} is null or jsonb_typeof(${table.description}) = 'object'`
		)
	]
);

/** Tag cross-reference for photos (storage line §3.4). */
export const photoTags = pgTable(
	'photo_tags',
	{
		photoId: uuid('photo_id')
			.notNull()
			.references(() => photos.id, { onDelete: 'cascade' }),
		tagId: uuid('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' })
	},
	(table) => [
		sql`PRIMARY KEY (${table.photoId}, ${table.tagId})`,
		index('photo_tags_tag_idx').on(table.tagId, table.photoId)
	]
);

import { sql } from 'drizzle-orm';
import {
	bigint,
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
import { user } from '../auth.schema';

export type FileStatus = 'pending' | 'attached' | 'detached';

/**
 * Blob registry (storage line §3.1): content-addressed object store entries.
 * Original bytes are private; public variants are derived by key convention.
 */
export const files = pgTable(
	'files',
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
		objectKey: text('object_key').notNull(),
		contentHash: text('content_hash').notNull(),
		fileName: text('file_name').notNull(),
		mimeType: text('mime_type').notNull(),
		byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
		width: integer('width'),
		height: integer('height'),
		thumbhash: text('thumbhash'),
		palette: jsonb('palette').$type<Record<string, unknown>>(),
		status: text('status').notNull().default('pending'),
		detachedAt: timestamp('detached_at', { withTimezone: true }),
		uploadedBy: text('uploaded_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		uniqueIndex('files_object_key_uniq').on(table.objectKey),
		uniqueIndex('files_content_hash_uniq').on(table.contentHash),
		index('files_status_created_idx').on(table.status, table.createdAt),
		index('files_uploaded_by_idx')
			.on(table.uploadedBy)
			.where(sql`${table.uploadedBy} is not null`),
		index('files_status_detached_idx').on(table.status, table.detachedAt),
		check('files_status_check', sql`${table.status} in ('pending', 'attached', 'detached')`)
	]
);

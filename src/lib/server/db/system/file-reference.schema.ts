import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';

export const fileReferences = pgTable(
	'file_references',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		fileUrl: text('file_url').notNull(),
		fileName: text('file_name').notNull(),
		status: text('status').notNull(),
		refId: uuid('ref_id'),
		refType: text('ref_type'),
		s3ObjectKey: text('s3_object_key'),
		readerId: text('reader_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		uploadedBy: text('uploaded_by').references(() => user.id, {
			onDelete: 'set null'
		}),
		mimeType: text('mime_type'),
		byteSize: bigint('byte_size', { mode: 'number' }),
		detachedAt: timestamp('detached_at', { withTimezone: true })
	},
	(table) => [
		index('file_references_file_url_idx').on(table.fileUrl),
		index('file_references_ref_idx').on(table.refId, table.refType),
		index('file_references_status_created_idx').on(table.status, table.createdAt),
		index('file_references_reader_status_created_idx').on(
			table.readerId,
			table.status,
			table.createdAt
		),
		// §4.6: SET NULL FK on the auth table needs a leading index.
		index('file_references_uploaded_by_idx').on(table.uploadedBy),
		index('file_references_status_detached_idx').on(table.status, table.detachedAt)
	]
);

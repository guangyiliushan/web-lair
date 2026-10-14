import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { files } from '../content/file.schema';

/** ref_type whitelist; the `'draft'` value lands with the ST-3 3b2 CHECK append. */
export const FILE_REF_TYPES = ['post', 'note', 'page', 'comment', 'draft'] as const;

export type FileRefType = (typeof FILE_REF_TYPES)[number];

/** Pure junction table (storage line §3.2): file ↔ content references. */
export const fileReferences = pgTable(
	'file_references',
	{
		fileId: uuid('file_id')
			.notNull()
			.references(() => files.id, { onDelete: 'no action' }),
		refType: text('ref_type').notNull(),
		refId: uuid('ref_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.fileId, table.refType, table.refId] }),
		index('file_references_ref_idx').on(table.refType, table.refId),
		check(
			'file_references_ref_type_check',
			sql`${table.refType} in ('post', 'note', 'page', 'comment', 'draft')`
		)
	]
);

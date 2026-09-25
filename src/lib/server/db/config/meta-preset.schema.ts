import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const metaPresets = pgTable(
	'meta_presets',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		name: text('name').notNull(),
		contentType: text('content_type'),
		description: text('description'),
		fields: jsonb('fields')
			.$type<unknown[]>()
			.notNull()
			.default(sql`'[]'::jsonb`)
	},
	(table) => [uniqueIndex('meta_presets_name_uniq').on(table.name)]
);

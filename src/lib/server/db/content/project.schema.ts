import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const projects = pgTable(
	'projects',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		previewUrl: text('preview_url'),
		docUrl: text('doc_url'),
		projectUrl: text('project_url'),
		images: text('images').array(),
		description: text('description').notNull(),
		avatar: text('avatar'),
		text: text('text')
	},
	(table) => [uniqueIndex('projects_name_uniq').on(table.name)]
);

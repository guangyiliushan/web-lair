import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const snippets = pgTable(
	'snippets',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		type: text('type'),
		isPrivate: boolean('is_private').notNull().default(false),
		raw: text('raw').notNull(),
		path: text('path').notNull(),
		comment: text('comment'),
		metaType: text('meta_type'),
		schema: text('schema'),
		method: text('method'),
		secret: text('secret'),
		isEnabled: boolean('is_enabled').notNull().default(true),
		builtIn: boolean('built_in').notNull().default(false),
		compiledCode: text('compiled_code')
	},
	(table) => [
		index('snippets_path_prefix_idx').on(table.path),
		index('snippets_type_idx').on(table.type),
		uniqueIndex('snippets_path_idx')
			.on(table.path)
			.where(sql`${table.method} is null`),
		uniqueIndex('snippets_path_method_idx')
			.on(table.path, table.method)
			.where(sql`${table.method} is not null`)
	]
);

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const options = pgTable(
	'options',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		name: text('name').notNull(),
		value: jsonb('value').$type<unknown>()
	},
	(table) => [uniqueIndex('options_name_uniq').on(table.name)]
);

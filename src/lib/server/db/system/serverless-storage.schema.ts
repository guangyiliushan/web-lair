import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const serverlessStorages = pgTable(
	'serverless_storages',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		namespace: text('namespace').notNull(),
		key: text('key').notNull(),
		value: jsonb('value').$type<unknown>().notNull()
	},
	(table) => [uniqueIndex('serverless_storages_ns_key_uniq').on(table.namespace, table.key)]
);

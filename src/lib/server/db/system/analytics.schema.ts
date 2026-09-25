import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const analytics = pgTable(
	'analytics',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		visitedAt: timestamp('visited_at', { withTimezone: true }).notNull(),
		ip: text('ip'),
		userAgent: jsonb('user_agent').$type<Record<string, unknown> | null>(),
		country: text('country'),
		path: text('path'),
		referrer: text('referrer')
	},
	(table) => [
		index('analytics_visited_at_idx').on(table.visitedAt),
		index('analytics_visited_at_path_idx').on(table.visitedAt, table.path),
		index('analytics_visited_at_referrer_idx').on(table.visitedAt, table.referrer),
		index('analytics_visited_at_ip_idx').on(table.visitedAt, table.ip)
	]
);

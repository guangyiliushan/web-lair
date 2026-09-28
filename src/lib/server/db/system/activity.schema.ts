import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';

export type ActivityRefType =
	| 'post'
	| 'note'
	| 'page'
	| 'comment'
	| 'link'
	| 'project'
	| 'photo'
	| 'file'
	| 'settings'
	| 'ai'
	| 'user'
	| 'member'
	| 'job'
	| 'schedule';

/** Admin action audit trail (platform §D.2): dotted event names, optional ref arc. */
export const activities = pgTable(
	'activities',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		event: text('event').notNull(),
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		refType: text('ref_type'),
		refId: uuid('ref_id'),
		payload: jsonb('payload').$type<Record<string, unknown>>()
	},
	(table) => [
		index('activities_created_at_idx').on(table.createdAt),
		index('activities_event_created_idx').on(table.event, table.createdAt),
		index('activities_ref_created_idx')
			.on(table.refType, table.refId, table.createdAt)
			.where(sql`${table.refId} is not null`),
		index('activities_actor_idx')
			.on(table.actorId)
			.where(sql`${table.actorId} is not null`),
		check('activities_event_check', sql`${table.event} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
		check(
			'activities_ref_type_check',
			sql`${table.refType} is null or ${table.refType} in ('post','note','page','comment','link','project','photo','file','settings','ai','user','member','job','schedule')`
		),
		// ref_type and ref_id must be paired.
		check('activities_ref_pair_check', sql`(${table.refType} is null) = (${table.refId} is null)`)
	]
);

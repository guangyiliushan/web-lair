import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * "Moments" stream (micro-content line §17): micro life/tech/media check-ins.
 * Renamed from `recent_items`; `type` is the kind, `metadata` / `ref_type` /
 * `ref_id` stay as extension slots (`ref_type` CHECK whitelist is still open
 * - ledger §9.5 / §17.8). Language-neutral; no comments (ledger §9.5) - the
 * up/down vote counters stay.
 */
export const moments = pgTable(
	'moments',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		content: text('content').notNull().default(''),
		type: text('type').notNull(),
		metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
		refType: text('ref_type'),
		refId: uuid('ref_id'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		up: integer('up').notNull().default(0),
		down: integer('down').notNull().default(0)
	},
	(table) => [
		check('moments_type_check', sql`${table.type} in ('life', 'tech', 'media', 'other')`),
		index('moments_ref_idx').on(table.refType, table.refId),
		index('moments_created_at_idx').on(table.createdAt),
		index('moments_type_created_idx').on(table.type, table.createdAt)
	]
);

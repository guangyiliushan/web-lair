import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { links } from './link.schema.ts';

/**
 * Precheck runs (links L4): one row per invocation of the application-stage
 * precheck. Deliberately a child table, not an entry in `links.recent_checks`
 * — the ring is a bounded (10) checker-evidence window, so a badge or a
 * cooldown read from it would silently lose data once the checker runs.
 *
 * `status = 'running'` doubles as the single-flight lock: the partial unique
 * index allows one in-flight run per link, and anything older than the stale
 * window is reclaimed before the next attempt. `ok` stays null while running
 * (and for reclaimed rows), so a half-finished run can never read as a pass.
 */
export const linkPrechecks = pgTable(
	'link_prechecks',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		linkId: uuid('link_id')
			.notNull()
			.references(() => links.id, { onDelete: 'cascade' }),
		trigger: text('trigger').notNull(),
		status: text('status').notNull().default('running'),
		ok: boolean('ok'),
		reach: text('reach'),
		backlink: text('backlink'),
		errorKind: text('error_kind'),
		note: text('note'),
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		durationMs: integer('duration_ms')
	},
	(table) => [
		index('link_prechecks_latest_idx').on(table.linkId, table.startedAt.desc()),
		uniqueIndex('link_prechecks_running_uniq')
			.on(table.linkId)
			.where(sql`${table.status} = 'running'`),
		// FK-leading index (baseline A7 gate); partial because anonymous
		// application runs carry no actor.
		index('link_prechecks_actor_idx')
			.on(table.actorId)
			.where(sql`${table.actorId} is not null`),
		check('link_prechecks_status_check', sql`${table.status} in ('running', 'completed', 'stale')`),
		check('link_prechecks_trigger_check', sql`${table.trigger} in ('application', 'admin')`),
		check(
			'link_prechecks_finished_check',
			sql`(${table.status} = 'running') = (${table.finishedAt} is null)`
		),
		check(
			'link_prechecks_ok_check',
			sql`(${table.status} = 'completed') = (${table.ok} is not null)`
		)
	]
);

export type LinkPrecheckRow = typeof linkPrechecks.$inferSelect;
export type LinkPrecheckTrigger = 'application' | 'admin';
export type LinkPrecheckStatus = 'running' | 'completed' | 'stale';

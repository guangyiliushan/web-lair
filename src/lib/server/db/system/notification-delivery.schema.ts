import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * Notification outbox: one row per `(event_type, event_key, channel)` is the idempotency contract.
 * Retries stay `queued` with `attempts` / `next_attempt_at` advanced; `payload` is bounded and free
 * of addresses, IPs, stack traces and credentials.
 * No FK to `comment`/`job_runs`: the log must outlive them; `jobs.prune` owns retention.
 */
export type NotificationChannel = 'email' | 'bark';
export type NotificationStatus = 'queued' | 'sent' | 'failed';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['email', 'bark'] as const;

export const notificationDeliveries = pgTable(
	'notification_deliveries',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		/** Dotted event name from the roster (`comment.pending`, `job.failed`, ...). */
		eventType: text('event_type').notNull(),
		/** Dedupe key inside the event type (`comment:<id>`, `job_run:<id>`, `disk:/data:<day>`). */
		eventKey: text('event_key').notNull(),
		channel: text('channel').notNull(),
		status: text('status').notNull().default('queued'),
		/** Attempts already made; increments on every claim-and-send round. */
		attempts: integer('attempts').notNull().default(0),
		/** Earliest time the next attempt may run (retry backoff). */
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
		/** HTTP status (Bark) or null (email / transport failure). */
		responseCode: integer('response_code'),
		/** Sanitized, bounded failure text - never a body, address or credential. */
		error: text('error'),
		payload: jsonb('payload')
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		sentAt: timestamp('sent_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('notification_deliveries_event_channel_uniq').on(
			table.eventType,
			table.eventKey,
			table.channel
		),
		index('notification_deliveries_due_idx').on(table.status, table.nextAttemptAt),
		// Delivery log page (created_at desc, limit 50) and `jobs.prune`'s
		// retention delete both scan by age; the due index cannot serve them.
		index('notification_deliveries_created_at_idx').on(table.createdAt),
		check('notification_deliveries_channel_check', sql`${table.channel} in ('email', 'bark')`),
		check(
			'notification_deliveries_status_check',
			sql`${table.status} in ('queued', 'sent', 'failed')`
		),
		check('notification_deliveries_attempts_check', sql`${table.attempts} >= 0`),
		// Event names follow the activities vocabulary (one or more dotted
		// lowercase segments), with room for the probe event names
		// (`mail.probe.failed`) that the single-dot activities CHECK rejects.
		check(
			'notification_deliveries_event_type_check',
			sql`${table.eventType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`
		),
		check(
			'notification_deliveries_event_key_check',
			sql`length(${table.eventKey}) between 1 and 200 and ${table.eventKey} !~ '\\s'`
		)
	]
);

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
 * Notification delivery outbox (M6 P5, decision register §3E N8; plan §3.2).
 *
 * One row per (event, dedupe key, channel). Business transactions insert the
 * row (`comment.pending` rides the comment insert's transaction; job/ops
 * producers go through the notification sink), and the drain's notification
 * segment claims it with `FOR UPDATE SKIP LOCKED` and hands it to the email /
 * Bark adapter.
 *
 * The unique key `(event_type, event_key, channel)` is the idempotency
 * contract: the same comment / the same job run / the same day's disk alert
 * can only ever produce ONE row per channel, so a retried producer, a drain
 * crash after the send, and a manual resend all converge on the same row
 * (same semantics as the webhook `webhook-id`). A resend re-queues that row
 * instead of copying it.
 *
 * Status is deliberately three-valued (`queued | sent | failed`): a retry
 * stays `queued` with `attempts` incremented and `next_attempt_at` pushed
 * forward, exactly like `webhook_deliveries` (decision N5/T2b), so "is this
 * row still going to be tried?" is readable from status alone.
 *
 * `payload` carries only what the adapters render - `{ title, body, url? }`,
 * bounded (title <= 120, body <= 200 characters) and free of addresses, IPs,
 * stack traces and credentials. The producers sanitize before insert; the
 * adapters re-truncate so a hand-written row cannot turn into a PII leak in
 * Bark/email.
 *
 * No FK to `comment`/`job_runs`: the row must outlive a deleted comment or a
 * pruned run (the delivery log is the record, and `jobs.prune` owns its
 * retention). `event_key` is the textual reference (`comment:<uuid>`,
 * `job_run:<uuid>`, `disk:/data:<day>`).
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
		// lowercase segments), with room for the P4 probe names
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

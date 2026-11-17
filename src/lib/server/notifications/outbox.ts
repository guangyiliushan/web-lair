import { and, eq, gte, sql } from 'drizzle-orm';
import { notificationDeliveries } from '../db/system/notification-delivery.schema.ts';
import type { JobsDb } from '../jobs/types.ts';
import { isNotificationEventType, type NotificationEventType } from './events.ts';
import { buildNotificationPayload, redactNotificationError } from './format.ts';
import { NOTIFICATION_GLOBAL_LIMIT_PER_HOUR, eventLimitPerHour } from './limits.ts';
import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	enabledChannels,
	readNotificationPreferences,
	type NotificationPreferenceDb,
	type NotificationPreferences
} from './preferences.ts';
import type { NotificationSink } from './notify.ts';

/**
 * Notification outbox writer: `enqueueNotification` turns one event into one
 * `queued` row per enabled channel, inside the SAVEPOINT it creates for
 * itself — both callers use that mechanism. The comment service calls it
 * INSIDE the comment insert's transaction, so a notification either commits
 * with the comment or not at all, while a failed enqueue (DB error, bad key)
 * rolls back only the savepoint and never the business write; the drain's
 * `notify()` sink passes its own db handle with the same mechanism.
 * Idempotency is the table's unique key `(event_type, event_key, channel)`:
 * `on conflict do nothing` makes a duplicate enqueue a no-op (`duplicate`),
 * so a producer that runs twice (retried tick, replayed request) can never
 * double-notify.
 * Storm suppression (limits.ts) is checked inside the same transaction: the
 * hourly window counts only committed rows, so sequential floods collapse
 * deterministically; concurrent producers can overshoot by the in-flight
 * count (registered: a bounded, non-alerting overshoot, never an unbounded
 * flood). Node-strip-loadable: relative `.ts` imports, no `$lib`, no virtual
 * modules.
 */
export type NotificationOutboxDb = JobsDb;

export interface NotificationInput {
	/** Registered event type (`NOTIFICATION_EVENTS`). */
	eventType: string;
	/** Dedupe key inside the event type; must match the table CHECK (no spaces, 1..200). */
	eventKey: string;
	title: string;
	body: string;
	url?: string | null;
}

/**
 * `enqueued`   - at least one row inserted
 * `duplicate`  - every channel row already existed (idempotent replay)
 * `suppressed` - an hourly window is full (log line written, nothing stored)
 * `skipped`    - the operator disabled every channel for this event's group
 * `failed`     - unknown event type, invalid key, or a DB error (logged)
 */
export type EnqueueOutcome = 'enqueued' | 'duplicate' | 'suppressed' | 'skipped' | 'failed';

export interface EnqueueDeps {
	now?: () => Date;
	/** Pre-read preferences (the drain reads them once per tick). */
	preferences?: NotificationPreferences;
	log?: (line: string) => void;
}

const EVENT_KEY_PATTERN = /^[^\s]{1,200}$/;

/** Insert one row per enabled channel inside a savepoint. */
export async function enqueueNotification(
	executor: NotificationOutboxDb,
	input: NotificationInput,
	deps: EnqueueDeps = {}
): Promise<EnqueueOutcome> {
	const log = deps.log ?? ((line: string) => console.log(line));
	if (!isNotificationEventType(input.eventType)) {
		// A typo must be loud: it is a producer bug, and the row would never
		// be delivered because no adapter knows the type.
		log(`[notify] unknown event type "${input.eventType}" (event key ${input.eventKey})`);
		return 'failed';
	}
	if (!EVENT_KEY_PATTERN.test(input.eventKey)) {
		log(`[notify] invalid event key for ${input.eventType}: "${input.eventKey.slice(0, 60)}"`);
		return 'failed';
	}
	const eventType: NotificationEventType = input.eventType;
	const now = (deps.now ?? (() => new Date()))();
	const payload = buildNotificationPayload(input);

	try {
		return await executor.transaction(async (tx) => {
			let preferences: NotificationPreferences;
			try {
				preferences =
					deps.preferences ??
					(await readNotificationPreferences(tx as unknown as NotificationPreferenceDb));
			} catch (error) {
				// Settings unreadable is a DB problem, not an operator choice:
				// fall through to the defaults so an alert is still sent.
				log(`[notify] preferences read failed: ${redactNotificationError(error)}`);
				preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
			}
			const channels = enabledChannels(eventType, preferences);
			if (channels.length === 0) {
				log(`[notify] skipped ${eventType} ${input.eventKey}: every channel is disabled`);
				return 'skipped';
			}

			const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
			const [globalRow] = await tx
				.select({ count: sql<number>`count(*)::int` })
				.from(notificationDeliveries)
				.where(gte(notificationDeliveries.createdAt, windowStart));
			const globalCount = Number(globalRow?.count ?? 0);
			if (globalCount >= NOTIFICATION_GLOBAL_LIMIT_PER_HOUR) {
				log(
					`[notify] suppressed ${eventType} ${input.eventKey}: global window full ` +
						`(${globalCount}/${NOTIFICATION_GLOBAL_LIMIT_PER_HOUR} per hour)`
				);
				return 'suppressed';
			}
			const perEventLimit = eventLimitPerHour(eventType);
			const [eventRow] = await tx
				.select({ count: sql<number>`count(*)::int` })
				.from(notificationDeliveries)
				.where(
					and(
						eq(notificationDeliveries.eventType, eventType),
						gte(notificationDeliveries.createdAt, windowStart)
					)
				);
			const eventCount = Number(eventRow?.count ?? 0);
			if (eventCount >= perEventLimit) {
				log(
					`[notify] suppressed ${eventType} ${input.eventKey}: event window full ` +
						`(${eventCount}/${perEventLimit} per hour)`
				);
				return 'suppressed';
			}

			const inserted = await tx
				.insert(notificationDeliveries)
				.values(
					channels.map((channel) => ({
						eventType,
						eventKey: input.eventKey,
						channel,
						status: 'queued',
						attempts: 0,
						nextAttemptAt: now,
						payload
					}))
				)
				.onConflictDoNothing({
					target: [
						notificationDeliveries.eventType,
						notificationDeliveries.eventKey,
						notificationDeliveries.channel
					]
				})
				.returning({ id: notificationDeliveries.id });
			return inserted.length > 0 ? 'enqueued' : 'duplicate';
		});
	} catch (error) {
		// A failed enqueue must never fail the caller's business write; the
		// savepoint rolled back and the caller keeps its transaction.
		log(
			`[notify] enqueue failed for ${eventType} ${input.eventKey}: ${redactNotificationError(error)}`
		);
		return 'failed';
	}
}

/**
 * The `notify()` sink the drain installs: the builtin probes call `notify()`,
 * this adapter is what turns those calls into outbox rows. A failure is
 * rethrown so `notify()` reports `failed` and the producer drops its daily
 * latch - a latched failure would silence the alert for the rest of the day.
 */
export function createNotificationSink(
	db: NotificationOutboxDb,
	deps: EnqueueDeps = {}
): NotificationSink {
	return async (event) => {
		const outcome = await enqueueNotification(
			db,
			{
				eventType: event.eventType,
				eventKey: event.eventKey,
				title: event.title,
				body: event.body,
				url: event.url ?? null
			},
			deps
		);
		// `suppressed` is NOT a delivery: the hourly window dropped the row, so the
		// producer must keep failing (and drop its daily latch) and retry once the
		// window frees up. Reporting it as delivered would silence the alert for
		// the rest of the day - the exact failure this latch contract exists to
		// prevent. `duplicate`, `skipped` and `enqueued` are final.
		if (outcome === 'failed' || outcome === 'suppressed') {
			throw new Error(`notification enqueue ${outcome} for ${event.eventType}`);
		}
	};
}

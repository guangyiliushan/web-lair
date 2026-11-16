import type { NotificationChannel } from '../db/system/notification-delivery.schema.ts';

/**
 * Notification event roster (M6 P5; decision register §3E N7, plan §3.2).
 *
 * The roster is the single place an event type, its preference group and the
 * channels it may ever use are declared. Producers (`comment.pending` in the
 * comment service, `job.failed` in the drain, the P4 probes through the
 * `notify()` seam) name an event; `notifications/outbox.ts` refuses a type
 * that is not registered here, so a typo cannot create a row nothing will
 * ever deliver.
 *
 * Groups, not per-event switches, drive preferences: the settings page edits
 * `notifications.preferences` per group (`comment`, `job`, `ops`), and a new
 * event in an existing group inherits the operator's choice. Adding an event
 * is therefore additive - no schema change, no migration.
 *
 * Registered events:
 *  - `comment.pending`   - a reader's comment entered the moderation queue.
 *  - `job.failed`        - a job run reached the terminal `failed` state and
 *                          its name is on `JOB_FAILURE_ALERT_WHITELIST`.
 *  - `system.disk_high` / `system.memory_high` - F-7 threshold alerts (P4).
 *  - `mail.probe.failed` - the F-10 mail probe failed (P4).
 *
 * Node-strip-loadable (type-only import), because the drain imports this.
 */
export type NotificationGroup = 'comment' | 'job' | 'ops';

export interface NotificationEventDefinition {
	/** Preference group the channel switches live under. */
	group: NotificationGroup;
	/** Channels this event may ever use; preferences narrow the set per group. */
	channels: readonly NotificationChannel[];
	/** One line for the settings page and the evidence receipts. */
	description: string;
}

export const NOTIFICATION_EVENTS = {
	'comment.pending': {
		group: 'comment',
		channels: ['email', 'bark'],
		description: 'A reader comment entered the moderation queue'
	},
	'job.failed': {
		group: 'job',
		channels: ['email', 'bark'],
		description: 'A whitelisted job run failed terminally'
	},
	'system.disk_high': {
		group: 'ops',
		channels: ['email', 'bark'],
		description: 'A monitored mount crossed the disk threshold'
	},
	'system.memory_high': {
		group: 'ops',
		channels: ['email', 'bark'],
		description: 'Container memory crossed the threshold'
	},
	'mail.probe.failed': {
		group: 'ops',
		channels: ['email', 'bark'],
		description: 'The SMTP probe failed (configuration, verify or weekly send)'
	}
} as const satisfies Record<string, NotificationEventDefinition>;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENTS;

export const NOTIFICATION_EVENT_TYPES = Object.keys(
	NOTIFICATION_EVENTS
) as readonly NotificationEventType[];

/**
 * Jobs whose terminal failure is worth a human alert (decision register §3E
 * N7: whitelist `media.audit`). Builtin maintenance jobs stay OFF the list on
 * purpose: their failures are already recorded in `job_runs` and surfaced by
 * the drain heartbeat, and a nightly red run would otherwise mail every day -
 * the noise the register's rate-limit section warns about. `media.audit` is
 * the data-integrity job (media vs. files table); a red run there means the
 * archive is no longer verifiable.
 */
export const JOB_FAILURE_ALERT_WHITELIST: readonly string[] = ['media.audit'];

/** True when `value` is a registered notification event type. */
export function isNotificationEventType(value: string): value is NotificationEventType {
	return Object.hasOwn(NOTIFICATION_EVENTS, value);
}

/** True when a failed run of `job` should raise `job.failed`. */
export function shouldAlertJobFailure(job: string): boolean {
	return JOB_FAILURE_ALERT_WHITELIST.includes(job);
}

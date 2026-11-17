/**
 * Storm guards for the notification outbox: comment 10/h, job 1/run, global
 * 30/h; over-limit -> suppressed and logged.
 *
 * The per-key window is enforced by the table's unique key (one comment, one
 * job run, one day's disk alert per channel). These counters bound the
 * aggregate: a comment flood or a misconfigured probe must not turn into a
 * thousand pushes. Exceeding a window drops the ENQUEUE (there is no
 * `suppressed` row - the approved status set is `queued|sent|failed`) and
 * writes a log line, so the suppression is visible in the drain log instead
 * of being silent.
 */
export const NOTIFICATION_GLOBAL_LIMIT_PER_HOUR = 30;

/** Per-event hourly windows; an event without an entry uses the global one. */
export const NOTIFICATION_EVENT_LIMITS_PER_HOUR: Readonly<Record<string, number>> = {
	'comment.pending': 10
};

export function eventLimitPerHour(eventType: string): number {
	return NOTIFICATION_EVENT_LIMITS_PER_HOUR[eventType] ?? NOTIFICATION_GLOBAL_LIMIT_PER_HOUR;
}

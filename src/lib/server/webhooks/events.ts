/**
 * Webhook event roster (ledger §26 / platform plan §D.3). The registry lands
 * with the SY S2 first commit (Q4 ruling). v1 covers the jobs/schedule
 * families - the only events the producers emit today (job-scripts.ts emits
 * job.save/job.fork/job.revert/job.delete; maintenance routes emit job.run;
 * job-schedules.ts emits the schedule family). Content-domain events are
 * registered for a later expansion.
 *
 * Names must satisfy the activities CHECK format
 * (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`) - the SQL contract is pinned by the
 * unit teeth, so a future roster addition cannot drift from the constraint.
 *
 * v1 semantics note (review round-1 C2): `job.run` fires when an admin
 * ENQUEUES a manual run (the maintenance run / save-and-run actions);
 * schedule-driven executions and run terminal states are NOT emitted in v1
 * (the job_runs ledger is their record). Per-event `data` shapes follow the
 * emitting call sites; a formal per-event schema is a registered docs-pass
 * item (C5).
 */
export const WEBHOOK_EVENT_ROSTER = [
	'job.delete',
	'job.fork',
	'job.revert',
	'job.run',
	'job.save',
	'schedule.create',
	'schedule.delete',
	'schedule.toggle',
	'schedule.update'
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENT_ROSTER)[number];

/** True when `value` is one of the events the pipeline actually emits. */
export function isWebhookEventName(value: string): value is WebhookEventName {
	return (WEBHOOK_EVENT_ROSTER as readonly string[]).includes(value);
}

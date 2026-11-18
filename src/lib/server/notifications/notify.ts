// Notification seam: the single call site every ops probe uses to raise an alert. The default sink writes
// one structured warning line; the outbox writer (`notification_deliveries`) can be installed instead, so
// a probe can be wired without inventing a second delivery path.
// Contract: `notify()` never throws — alerting must not fail the job that observed the condition (the run
// ledger and the external healthchecks ping are the other, independent records). The sink is process-wide,
// set once at boot (`setNotificationSink`); the drain sets it per tick when the outbox is wired there.
// Payloads carry metric names and numbers only — never addresses, URLs or credentials.
// The return value distinguishes "no sink installed" (`skipped`) from "the sink rejected it" (`failed`):
// the caller keeps its daily latch only for `delivered`/`skipped`, and on `failed` it must drop the latch so
// the next tick retries — a day-scoped dedupe key plus a latched failure would otherwise silence the alert
// for the rest of the day. Delivery is at-least-once by design; the (event_type, event_key, channel)
// unique key absorbs the duplicate when a retry lands twice.

import { sanitizeErrorText } from '../jobs/error-text.ts';

/** One alert handed to the delivery layer. */
export interface NotificationEvent {
	/** Event name, e.g. `system.disk_high` (registered in the roster). */
	eventType: string;
	/** Dedupe key inside the event type, e.g. `disk:/data`. */
	eventKey: string;
	/** One-line subject. */
	title: string;
	/** Human-readable detail; bounded, no secrets. */
	body: string;
	/**
	 * Optional absolute link (admin page, run detail). The outbox stores it in
	 * the payload; the log-only default sink ignores it. Never a token carrier -
	 * `notifications/format.ts` strips credentials, query and fragment.
	 */
	url?: string | null;
}

/**
 * `delivered` = a sink accepted it; `skipped` = no sink installed (the log line
 * is the record for now); `failed` = a sink threw and the caller should retry.
 */
export type NotificationOutcome = 'delivered' | 'skipped' | 'failed';

/** Delivery backend; the outbox writer implements this shape. */
export type NotificationSink = (event: NotificationEvent) => void | Promise<void>;

let sink: NotificationSink | null = null;

/**
 * Install the delivery backend. `null` restores the log-only default;
 * tests use that to avoid leaking a sink into later cases.
 */
export function setNotificationSink(next: NotificationSink | null): void {
	sink = next;
}

/**
 * Raise one alert. Returns the delivery outcome (`skipped` when no sink is
 * installed); never throws.
 */
export async function notify(event: NotificationEvent): Promise<NotificationOutcome> {
	const active = sink;
	if (!active) {
		console.warn(`[notify] ${event.eventType} ${event.eventKey}: ${event.title}`);
		return 'skipped';
	}
	try {
		await active(event);
		return 'delivered';
	} catch (error) {
		// Fail-open: the probe that raised the alert still records its run and
		// pings healthchecks. The sink's error may embed a request URL, so it
		// goes through the shared sanitizer before it reaches a log line.
		const text = sanitizeErrorText(error instanceof Error ? error.message : String(error));
		console.warn(`[notify] sink failed for ${event.eventType}: ${text.slice(0, 200)}`);
		return 'failed';
	}
}

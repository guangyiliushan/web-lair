/**
 * Notification retry policy: one immediate attempt plus THREE retries on a
 * fixed backoff of 1m / 5m / 15m; the fourth failure is terminal. Fixed
 * (not exponential-with-jitter) because the receiver is our own SMTP relay
 * and Bark's API — no fleet of receivers to synchronize, and a predictable
 * schedule is what the delivery log promises the operator.
 * The row keeps its id across attempts (same `(event_type, event_key,
 * channel)` key), so a resend re-queues THIS row instead of creating a second
 * notification: the log reads as one notification with a history, not as N
 * notifications. The delay list is indexed by the attempts ALREADY made:
 * after attempt 1 the row waits 1m, after 2 → 5m, after 3 → 15m, after 4
 * the budget is spent.
 */
export const NOTIFICATION_MAX_ATTEMPTS = 4;
export const NOTIFICATION_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

export interface NotificationRetryPlan {
	retry: boolean;
	delayMs: number;
}

/** Plan the next attempt; `attemptsMade` includes the attempt that just failed. */
export function planNotificationRetry(attemptsMade: number): NotificationRetryPlan {
	if (!Number.isFinite(attemptsMade) || attemptsMade < 1) {
		return { retry: false, delayMs: 0 };
	}
	if (attemptsMade >= NOTIFICATION_MAX_ATTEMPTS) return { retry: false, delayMs: 0 };
	return {
		retry: true,
		delayMs: NOTIFICATION_RETRY_DELAYS_MS[attemptsMade - 1] ?? 0
	};
}

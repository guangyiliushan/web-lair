/**
 * Webhook retry policy.
 *
 * Classification follows the Standard Webhooks delivery contract and the
 * Stripe/GitHub behaviour: 2xx is success, 3xx is a permanent failure (the
 * delivery must never follow a redirect), 408/429/5xx and transport errors
 * are retryable, every other 4xx is permanent, and 410 Gone disables the
 * endpoint (the receiver said "stop sending").
 *
 * Backoff is exponential with +/-20% jitter so a receiver that comes back
 * after an outage does not get a synchronized retry stampede from every
 * endpoint at once. `Retry-After` (seconds or HTTP date) wins when it is
 * longer than the computed delay; it is clamped to the same cap.
 *
 * The retry count is per DELIVERY ROW, and the row keeps its id - the
 * `webhook-id` header is therefore stable across retries and manual replays,
 * which is what lets receivers deduplicate.
 */
/**
 * Retry budget: up to three days of
 * exponential backoff. Fourteen attempts with a 12-hour cap cover that window
 * (1m · 2m · … · 12h ≈ 65h) without keeping a poison row alive forever.
 */
export const WEBHOOK_MAX_ATTEMPTS = 14;
export const WEBHOOK_BASE_DELAY_MS = 60_000;
export const WEBHOOK_MAX_DELAY_MS = 12 * 60 * 60 * 1000;
export const WEBHOOK_JITTER_RATIO = 0.2;

export type WebhookResponseClass = 'success' | 'retryable' | 'permanent' | 'disable';

/** Classify the receiver's HTTP status. */
export function classifyWebhookResponse(status: number): WebhookResponseClass {
	if (status >= 200 && status < 300) return 'success';
	if (status === 410) return 'disable';
	if (status === 408 || status === 429 || status >= 500) return 'retryable';
	// 3xx (redirects are never followed) and every other 4xx.
	return 'permanent';
}

export interface WebhookRetryPlan {
	retry: boolean;
	delayMs: number;
}

/**
 * Plan the next attempt. `attemptsMade` is the count INCLUDING the attempt
 * that just failed (1 after the first failure).
 */
export function planWebhookRetry(
	attemptsMade: number,
	options: { random?: () => number; retryAfterMs?: number | null } = {}
): WebhookRetryPlan {
	if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return { retry: false, delayMs: 0 };
	const exponent = Math.max(0, attemptsMade - 1);
	const base = Math.min(WEBHOOK_BASE_DELAY_MS * 2 ** exponent, WEBHOOK_MAX_DELAY_MS);
	const random = options.random ?? Math.random;
	const jitter = 1 - WEBHOOK_JITTER_RATIO + random() * WEBHOOK_JITTER_RATIO * 2;
	const withJitter = Math.min(Math.round(base * jitter), WEBHOOK_MAX_DELAY_MS);
	const retryAfter = options.retryAfterMs;
	const delayMs =
		retryAfter !== null && retryAfter !== undefined
			? Math.min(Math.max(withJitter, retryAfter), WEBHOOK_MAX_DELAY_MS)
			: withJitter;
	return { retry: true, delayMs };
}

/**
 * Parse a `Retry-After` header: delta-seconds or an HTTP date. Returns null
 * for anything unparseable; a negative/past date yields 0.
 */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (!Number.isFinite(seconds)) return null;
		return Math.max(0, Math.min(seconds * 1000, WEBHOOK_MAX_DELAY_MS));
	}
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return Math.max(0, Math.min(at - now.getTime(), WEBHOOK_MAX_DELAY_MS));
}

/**
 * Webhook retry policy, per the Standard Webhooks delivery contract and
 * Stripe/GitHub behaviour: 2xx success; 3xx permanent (a delivery never
 * follows a redirect); 408/429/5xx and transport errors retryable; every
 * other 4xx permanent; 410 Gone disables the endpoint. Backoff is
 * exponential with ±20% jitter so receivers coming back from an outage do
 * not get a synchronized stampede; `Retry-After` (seconds or HTTP date) wins
 * when it is longer than the computed delay, clamped to the same cap. The
 * count is per DELIVERY ROW and the row keeps its id, so `webhook-id` stays
 * stable across retries and manual replays — what lets receivers
 * deduplicate. Budget: up to three days of exponential backoff — fourteen
 * attempts with a 12-hour cap cover it (1m · 2m · … · 12h ≈ 65h) without
 * keeping a poison row alive forever.
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

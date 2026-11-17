/**
 * Test-email throttling.
 *
 * A real send to the current admin's address is a live SMTP operation: it can
 * trigger provider rate limits, spam traps and delivery costs. One send per
 * minute and ten per hour is enough for an operator checking DKIM/headers and
 * small enough that a compromised admin session cannot turn the page into a
 * mail relay.
 *
 * The attempts are the `mail.test` audit rows themselves - one source of
 * truth, visible in the settings change history and shared across replicas
 * (an in-process counter would not be).
 */
export const MAIL_TEST_MIN_INTERVAL_MS = 60_000;
export const MAIL_TEST_MAX_PER_HOUR = 10;

export type MailTestRateVerdict =
	{ allowed: true } | { allowed: false; reason: 'too_soon' | 'hourly'; retryAfterMs: number };

/**
 * Evaluate recent attempts (any order, at most one hour old). The caller
 * queries by event+actor, so a burst from another admin cannot throttle this
 * one.
 */
export function evaluateMailTestRateLimit(
	attempts: readonly Date[],
	now: Date,
	limits: { minIntervalMs?: number; maxPerHour?: number } = {}
): MailTestRateVerdict {
	const minInterval = limits.minIntervalMs ?? MAIL_TEST_MIN_INTERVAL_MS;
	const maxPerHour = limits.maxPerHour ?? MAIL_TEST_MAX_PER_HOUR;
	const hourAgo = now.getTime() - 60 * 60 * 1000;
	const recent = attempts
		.map((at) => at.getTime())
		.filter((at) => Number.isFinite(at) && at > hourAgo)
		.sort((a, b) => b - a);
	if (recent.length === 0) return { allowed: true };

	const newest = recent[0];
	if (now.getTime() - newest < minInterval) {
		return {
			allowed: false,
			reason: 'too_soon',
			retryAfterMs: Math.max(0, minInterval - (now.getTime() - newest))
		};
	}
	if (recent.length >= maxPerHour) {
		// The oldest of the counted attempts frees a slot when it leaves the
		// rolling hour window.
		const oldest = recent[recent.length - 1];
		return {
			allowed: false,
			reason: 'hourly',
			retryAfterMs: Math.max(0, oldest + 60 * 60 * 1000 - now.getTime())
		};
	}
	return { allowed: true };
}

/** Subject/body for the operator test message (no secrets, no links). */
export function buildTestMailContent(
	now: Date,
	siteName?: string | null
): {
	subject: string;
	text: string;
} {
	const site = siteName?.trim() || 'web-lair';
	return {
		subject: `[${site}] SMTP test email`,
		text:
			`This is a test email from the ${site} admin Notifications page.\n\n` +
			`Sent at: ${now.toISOString()}\n` +
			'If you can read this, the configured SMTP transport accepted and delivered a message. ' +
			'Check the message headers/signature for the DKIM result.\n'
	};
}

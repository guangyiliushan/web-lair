import { randomBytes } from 'node:crypto';

/**
 * Webhook signing secrets: generated only, in
 * the Standard Webhooks shape - `whsec_` prefix + base64, with 24-64 bytes of
 * entropy (`SECRET_BYTES` below). Every endpoint carries its own secret;
 * rotation issues a fresh value, and the previous one stops verifying.
 */
const SECRET_BYTES = 32;

export function generateWebhookSecret(): string {
	return `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`;
}

/**
 * Display mask - the load path must never carry the raw secret to the admin
 * client. Keeps the recognizable prefix and the last four characters
 * (`whsec_…AbCd`); the full value is revealed exactly once, in the
 * create/rotate action result. The base64 padding (`=`) is dropped from the
 * mask so the tail shows four real characters.
 */
export function maskWebhookSecret(secret: string): string {
	const body = secret.replace(/=+$/, '');
	// Legacy/imported values can be arbitrarily short; revealing four tail
	// characters of a 10-char value would hide almost nothing. Keep the
	// prefix only for anything below a safe length (generated values are 51).
	if (body.length < 16) return `${body.slice(0, Math.min(6, body.length))}\u2026`;
	return `${body.slice(0, 6)}\u2026${body.slice(-4)}`;
}

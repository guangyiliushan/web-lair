import { randomBytes } from 'node:crypto';

/**
 * Webhook signing secrets (ledger §26 / 10-13 grill G5): generated only, in
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
 * create/rotate action result.
 */
export function maskWebhookSecret(secret: string): string {
	return `${secret.slice(0, 6)}\u2026${secret.slice(-4)}`;
}

import { createHmac } from 'node:crypto';

/**
 * Standard Webhooks signing.
 *
 * Content signed: `{webhook-id}.{webhook-timestamp}.{body}` delimited by full
 * stops; the HMAC-SHA256 digest is base64-encoded and prefixed `v1,`. Secrets
 * serialized as `whsec_<base64>` are decoded per spec; any other value is used
 * as raw UTF-8 bytes.
 */
const SIGNATURE_VERSION = 'v1';

export function signingKey(secret: string): Buffer {
	if (secret.startsWith('whsec_')) return Buffer.from(secret.slice('whsec_'.length), 'base64');
	return Buffer.from(secret, 'utf8');
}

export function signWebhookPayload(
	secret: string,
	webhookId: string,
	timestampSeconds: number,
	body: string
): string {
	const signed = `${webhookId}.${timestampSeconds}.${body}`;
	const digest = createHmac('sha256', signingKey(secret)).update(signed).digest('base64');
	return `${SIGNATURE_VERSION},${digest}`;
}

export interface WebhookSignatureHeaders {
	'webhook-id': string;
	'webhook-timestamp': string;
	'webhook-signature': string;
}

export function webhookHeaders(
	secret: string,
	webhookId: string,
	timestampSeconds: number,
	body: string,
	previousSecrets: readonly string[] = []
): WebhookSignatureHeaders {
	// Rotation grace window: every still-valid secret contributes one
	// `v1,<digest>` entry. The spec allows a space-delimited list, so a
	// receiver holding the old value keeps verifying while the new one is
	// already in use.
	const signatures = [secret, ...previousSecrets]
		.filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
		.map((value) => signWebhookPayload(value, webhookId, timestampSeconds, body))
		.join(' ');
	return {
		'webhook-id': webhookId,
		'webhook-timestamp': String(timestampSeconds),
		'webhook-signature': signatures
	};
}

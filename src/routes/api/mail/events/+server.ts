import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { decodeHmacKey } from '$lib/server/services/email-hash';
import { normalizeEmail } from '$lib/server/services/subscriptions';
import { suppress } from '$lib/server/services/suppressions';
import type { RequestHandler } from './$types';

/**
 * Provider-agnostic bounce / complaint intake (E2-4).
 *
 * A relay or MTA adapter POSTs `{ email, reason }` with an HMAC signature over
 * `<timestamp>.<raw-body>`:
 *
 *   x-mail-events-timestamp: <unix seconds>
 *   x-mail-events-signature: sha256=<hex>
 *
 * The endpoint has no session or cookies and is fail-closed: without
 * `MAIL_EVENTS_HMAC_KEY` it answers 503 instead of becoming an open
 * suppression API. Replays outside a five-minute window are rejected.
 */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_SKEW_SECONDS = 300;

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

function parseSignature(value: string | null): Buffer | null {
	if (!value) return null;
	const match = /^sha256=([0-9a-f]{64})$/i.exec(value.trim());
	return match ? Buffer.from(match[1], 'hex') : null;
}

export const POST: RequestHandler = async ({ request }) => {
	const key = decodeHmacKey(env.MAIL_EVENTS_HMAC_KEY);
	if (!key) return json({ error: 'mail_events_not_configured' }, 503);

	const timestamp = (request.headers.get('x-mail-events-timestamp') ?? '').trim();
	if (!/^\d+$/.test(timestamp)) return json({ error: 'invalid_timestamp' }, 401);
	const seconds = Number(timestamp);
	if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > MAX_SKEW_SECONDS) {
		return json({ error: 'stale_timestamp' }, 401);
	}

	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) return json({ error: 'body_too_large' }, 413);

	const provided = parseSignature(request.headers.get('x-mail-events-signature'));
	const expected = createHmac('sha256', key).update(`${timestamp}.${raw}`).digest();
	if (!provided || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		return json({ error: 'invalid_signature' }, 401);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
	if (!payload || typeof payload !== 'object') return json({ error: 'invalid_json' }, 400);

	const email = normalizeEmail(String((payload as { email?: unknown }).email ?? ''));
	if (!email) return json({ error: 'invalid_email' }, 400);

	const reason = (payload as { reason?: unknown }).reason;
	if (reason !== 'bounced' && reason !== 'complained') {
		return json({ error: 'invalid_reason' }, 400);
	}

	await suppress(email, reason, 'mail-events');
	return json({ ok: true }, 200);
};

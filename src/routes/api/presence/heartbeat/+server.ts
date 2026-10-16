import type { RequestHandler } from './$types';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { PRESENCE_BUCKETS, touchPresence } from '$lib/server/services/presence';
import { isUuid } from '$lib/utils/uuid';
import { PRESENCE_HEARTBEAT_RATE_LIMIT, presenceHeartbeatLimitKey } from './limit';

/**
 * Presence heartbeat (realtime batch R2, ledger §23 / plan §B): one small
 * JSON POST per tab every 15s refreshing the site window, the day set, the
 * peak sentinel and — on content pages — the caller's position bucket.
 *
 * The endpoint is a dumb writer: it never reads options (the render side and
 * the stream gate the feature), it never touches IP or cookies, and success
 * is always 204 because heartbeats are best-effort — a dropped beat just
 * means the tab ages out of the 60s window.
 *
 * Guards: `application/json` required (415; this also keeps browser-form
 * CSRF carriers out — kit only origin-checks form content types), strict
 * `token` / `c` / `bucket` validation (400, before the limiter so a junk
 * token never spends a bucket), per-token bucket `limits:presence:<token>`
 * 15/60s fail-open (429 + X-Retry-After when exceeded — the client is a dumb
 * interval and only needs to know it may drop this beat).
 */

export const prerender = false;

interface HeartbeatInput {
	token: string;
	contentId?: string;
	bucket?: number;
}

function parseHeartbeat(body: unknown): HeartbeatInput | null {
	if (typeof body !== 'object' || body === null) return null;
	const { token, c, bucket } = body as Record<string, unknown>;
	if (typeof token !== 'string' || !isUuid(token)) return null;
	if (c !== undefined && (typeof c !== 'string' || !isUuid(c))) return null;
	if (bucket !== undefined) {
		if (typeof bucket !== 'number' || !Number.isInteger(bucket)) return null;
		if (bucket < 0 || bucket >= PRESENCE_BUCKETS) return null;
		// A bucket without a content id is a malformed intent, not a site beat.
		if (c === undefined) return null;
	}
	const parsed: HeartbeatInput = { token };
	if (typeof c === 'string') parsed.contentId = c;
	if (typeof bucket === 'number') parsed.bucket = bucket;
	return parsed;
}

export const POST: RequestHandler = async ({ request }) => {
	const mediaType = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
	if (mediaType !== 'application/json') return new Response(null, { status: 415 });

	let input: HeartbeatInput | null = null;
	try {
		input = parseHeartbeat(await request.json());
	} catch {
		// a malformed JSON body shares the 400 with a malformed payload
	}
	if (!input) return new Response(null, { status: 400 });

	const store = getCache();
	const rate = await rateLimit(
		store,
		presenceHeartbeatLimitKey(input.token),
		PRESENCE_HEARTBEAT_RATE_LIMIT.limit,
		PRESENCE_HEARTBEAT_RATE_LIMIT.windowSeconds
	);
	if (!rate.allowed) {
		return new Response(null, {
			status: 429,
			headers: { 'x-retry-after': String(PRESENCE_HEARTBEAT_RATE_LIMIT.windowSeconds) }
		});
	}

	await touchPresence(input, { store });
	return new Response(null, { status: 204 });
};

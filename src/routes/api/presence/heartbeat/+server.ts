import type { RequestHandler } from './$types';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { PRESENCE_BUCKETS, touchPresence } from '$lib/server/services/presence';
import { isUuid } from '$lib/utils/uuid';
import { PRESENCE_HEARTBEAT_RATE_LIMIT, presenceHeartbeatLimitKey } from './limit';

/**
 * Presence heartbeat: one small JSON POST per tab every 15s refreshing the site
 * window, the day set, the peak sentinel and - on content pages - the caller's
 * position bucket. It is a dumb writer: no option reads, no IP, no cookies, and
 * always 204, because a dropped beat merely ages the tab out of the 60s window.
 * Guards: `application/json` (415; kit only origin-checks form content types, so
 * this also keeps browser-form CSRF carriers out), strict `token` / `c` / `bucket`
 * validation (400 before the limiter, so junk never spends a bucket), then a
 * per-token 30/60s bucket (budget math in `limit.ts`) that fails open - a 429 with
 * `X-Retry-After` only tells the client's plain interval to drop this beat.
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

	// Cache construction may throw on a malformed VALKEY_URL; the endpoint is
	// a dumb writer whose contract is "always 204" - a configuration fault
	// drops the beat instead of surfacing a 500.
	try {
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
	} catch {
		// fail-open: a dead cache never answers anything but 204 here
	}
	return new Response(null, { status: 204 });
};

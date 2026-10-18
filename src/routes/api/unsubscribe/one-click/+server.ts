import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { isSubscriptionToken } from '$lib/server/services/subscription-token';
import { unsubscribe } from '$lib/server/services/subscriptions';
import type { RequestHandler } from './$types';

/**
 * RFC 8058 one-click unsubscribe.
 *
 * Mail receivers POST the `List-Unsubscribe-Post` key/value pair to the HTTPS
 * URI from `List-Unsubscribe` with **no cookies, no authorization and no
 * prior context** (§3.1). The token in the query string is the credential.
 *
 * Contract:
 * - `200` empty for a valid token (processed or already terminal) and for an
 *   unknown but well-formed token (no token oracle);
 * - `429 + Retry-After` when the per-IP seatbelt trips (a silent 200 would make
 *   the receiver drop a valid opt-out);
 * - `503` when the database write fails (retryable; 200 would lose the opt-out);
 * - no redirect (RFC 8058 §3.1 forbids it).
 *
 * A malformed token never reaches this handler in production: the CSRF hook
 * rejects it before routing (403).
 */
const ONE_CLICK_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

function clientAddress(getClientAddress: () => string): string {
	try {
		return getClientAddress() || 'unknown';
	} catch {
		// dev without ADDRESS_HEADER: one shared bucket
		return 'unknown';
	}
}

function empty(status: number, headers: Record<string, string> = {}): Response {
	return new Response(null, {
		status,
		headers: { 'cache-control': 'no-store', ...headers }
	});
}

export const POST: RequestHandler = async ({ url, getClientAddress }) => {
	const address = clientAddress(getClientAddress);
	const rate = await rateLimit(
		getCache(),
		`limits:unsubscribe-oneclick:${address}`,
		ONE_CLICK_RATE_LIMIT.limit,
		ONE_CLICK_RATE_LIMIT.windowSeconds
	);
	if (!rate.allowed) {
		console.warn('[unsubscribe] one-click rate limit hit');
		return empty(429, { 'retry-after': '60' });
	}

	const token = url.searchParams.get('token') ?? '';
	if (!isSubscriptionToken(token)) return empty(200);

	try {
		await unsubscribe(token);
	} catch (error) {
		// A 5xx is the only way to make the receiver retry; a 200 here would
		// silently drop a valid opt-out during a DB blip.
		console.error('[unsubscribe] one-click failed', error);
		return empty(503, { 'retry-after': '60' });
	}
	return empty(200);
};

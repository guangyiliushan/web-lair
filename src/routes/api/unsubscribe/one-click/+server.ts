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
 * - always `200` with an empty body, including unknown/malformed tokens
 *   (a status code must not become a token oracle);
 * - idempotent: `unsubscribe` tolerates pending/subscribed/already states;
 * - no redirect (RFC 8058 §3.1 forbids it);
 * - per-IP seatbelt only (30/min); a miss still answers 200.
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

export const POST: RequestHandler = async ({ url, getClientAddress }) => {
	const address = clientAddress(getClientAddress);
	const rate = await rateLimit(
		getCache(),
		`limits:unsubscribe-oneclick:${address}`,
		ONE_CLICK_RATE_LIMIT.limit,
		ONE_CLICK_RATE_LIMIT.windowSeconds
	);

	const token = url.searchParams.get('token') ?? '';
	if (rate.allowed && isSubscriptionToken(token)) {
		try {
			await unsubscribe(token);
		} catch (error) {
			// Still 200: the receiver only needs to know the request was accepted,
			// and a 5xx would make it retry a request the DB already rejected.
			console.error('[unsubscribe] one-click failed', error);
		}
	} else if (!rate.allowed) {
		console.warn('[unsubscribe] one-click rate limit hit');
	}

	return new Response(null, {
		status: 200,
		headers: { 'cache-control': 'no-store' }
	});
};

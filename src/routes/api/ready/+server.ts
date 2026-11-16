import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { getCache } from '$lib/server/cache';
import { db } from '$lib/server/db';
import { bearerMatches, evaluateReady, readyProbe } from '$lib/server/health/ready';
import { isInternalPeer } from '$lib/server/security/identity';
import { requestIp } from '$lib/server/security/request-address';
import type { RequestHandler } from './$types';

/**
 * Readiness. `/api/health` answers liveness for the container supervisor and
 * deliberately never touches dependencies; this endpoint is the opposite and is
 * deliberately NOT public:
 *
 *  - `READY_TOKEN` configured: a valid `Authorization: Bearer` is required
 *    from EVERY caller (the collector must inject the token; a missing or
 *    wrong bearer answers 401). The private-address shortcut is disabled in
 *    this mode so a proxy peer address can never stand in for a credential.
 *  - no token in production: 404 to every caller. `getClientAddress()` reads
 *    the address from `ADDRESS_HEADER` (X-Forwarded-For) when adapter-node is
 *    configured that way, so a "private" peer is a header value that the
 *    caller can forge; refusing to serve is the only safe fallback.
 *  - no token outside production: only loopback/private peers (RFC 1918, ULA,
 *    link-local) pass - public callers get 404 so the route is not advertised.
 *
 * `deploy/Caddyfile` answers 404 for `/api/ready` at the edge, so the token
 * gate is the second fence, not the only one.
 *
 * Response: 200 `{status:'ready',db:'ok',valkey:'ok'}`; 503 with the same
 * per-check detail (`ok`/`fail`/`timeout`/`disabled`). Answers are cached for
 * 10s per process; `cached` says whether this body was just computed.
 */
export const prerender = false;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});
}

export const GET: RequestHandler = async ({ request, getClientAddress }) => {
	const production = env.NODE_ENV === 'production';
	const token = env.READY_TOKEN?.trim();
	if (token) {
		// Token mode: the credential is the only fence, whatever the peer is.
		if (!bearerMatches(request.headers.get('authorization'), token)) {
			return json({ status: 'unauthorized' }, 401);
		}
	} else if (production) {
		// Fail closed: without a token, "private peer" is an X-Forwarded-For
		// value a caller can forge. Production must configure READY_TOKEN.
		return new Response(null, { status: 404 });
	} else if (!isInternalPeer(requestIp(getClientAddress))) {
		// No token outside production: private/loopback only; everyone else
		// sees the same 404 as a missing route.
		return new Response(null, { status: 404 });
	}

	const cache = getCache();
	const result = await readyProbe().read(() =>
		evaluateReady({
			db: () => db.execute(sql`select 1`),
			valkey: env.VALKEY_URL?.trim() ? () => cache.ping() : null
		})
	);
	return json(result, result.status === 'ready' ? 200 : 503);
};

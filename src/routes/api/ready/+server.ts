import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { getCache } from '$lib/server/cache';
import { db } from '$lib/server/db';
import { bearerMatches, evaluateReady, readyProbe } from '$lib/server/health/ready';
import { isInternalPeer } from '$lib/server/security/identity';
import { requestIp } from '$lib/server/security/request-address';
import type { RequestHandler } from './$types';

/**
 * Readiness: the opposite of `/api/health` (liveness for the container supervisor, which
 * never touches dependencies), and deliberately NOT public.
 * Modes, in order: `READY_TOKEN` configured → every caller needs that bearer (401 otherwise)
 * and the private-address shortcut is disabled; no token in production → 404 for everyone
 * (fail closed); no token elsewhere → loopback/private peers only (RFC 1918, ULA,
 * link-local), public callers get the 404 a missing route would give. The reason for each
 * mode sits with its branch below.
 * `deploy/Caddyfile` answers 404 for `/api/ready` at the edge, so the token gate is the
 * second fence, not the only one.
 * Response: 200 `{status:'ready',db:'ok',valkey:'ok'}` or 503 with the same per-check detail
 * (`ok`/`fail`/`timeout`/`disabled`); answers are cached for 10s per process and `cached`
 * says whether this body was just computed.
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

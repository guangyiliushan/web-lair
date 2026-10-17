import type { RequestHandler } from './$types';

export const prerender = false;

/**
 * Container health endpoint (D-1): the compose healthcheck polls this, and
 * Caddy only starts once it answers. Deliberately dependency-free — a DB or
 * Valkey blip must not make the container look dead (those are monitored by
 * Kuma, not by the process supervisor).
 */
export const GET: RequestHandler = async () =>
	new Response(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store'
		}
	});

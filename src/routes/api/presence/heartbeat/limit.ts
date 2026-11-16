/**
 * Rate-limit contract for the presence heartbeat. A sibling module rather than an
 * export of `+server.ts`: SvelteKit route modules only allow +-prefixed exports and
 * the production route analysis rejects anything else.
 * Budget: a content detail page runs two 15s loops (site plus widget = 8/min) and
 * scroll-early reports add up to 12/min more, so 30 per tab leaves headroom. The 429
 * path is fail-open - the client drops the beat. That header is the custom
 * `X-Retry-After`; no consumer reads it yet.
 * The key is the CLIENT-MINTED token, so this only bounds a well-behaved tab and is
 * not abuse protection - the entry-side gates carry that threat class.
 */
export const PRESENCE_HEARTBEAT_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

export function presenceHeartbeatLimitKey(token: string): string {
	return `limits:presence:${token}`;
}

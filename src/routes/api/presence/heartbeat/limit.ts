/**
 * Rate-limit contract for the presence heartbeat (realtime R2; review M6).
 * A sibling module rather than an export of `+server.ts`: SvelteKit route
 * modules only allow +-prefixed exports, and the production build's route
 * analysis rejects anything else (caught by the batch-tail preview build).
 *
 * Budget (review finding): a content detail page runs TWO 15s loops (the
 * site loop plus the widget's contextual loop = 8/min) and the scroll-early
 * reports add up to 12/min more — ≤20 requests per minute per tab, so the
 * bucket is 30 (headroom) rather than the originally registered 15. The 429
 * path is fail-open: the client drops the beat and the 60s window keeps the
 * tab counted through the remaining beats.
 *
 * The header is the custom `X-Retry-After` (register C1); no consumer reads
 * it yet (the client silently keeps beating). Revisit the standard
 * `Retry-After` spelling if a consumer ever needs it.
 *
 * Nature of the bucket (review note): the key is the CLIENT-MINTED token, so
 * per-token throttling only bounds a well-behaved tab — it is not abuse
 * protection (a script can rotate tokens freely). The entry-side gates
 * (deployment batch) are the load-bearing wall for that threat class.
 */
export const PRESENCE_HEARTBEAT_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

export function presenceHeartbeatLimitKey(token: string): string {
	return `limits:presence:${token}`;
}

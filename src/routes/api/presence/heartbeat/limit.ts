/**
 * Rate-limit contract for the presence heartbeat (realtime R2). A sibling
 * module rather than an export of `+server.ts`: SvelteKit route modules only
 * allow +-prefixed exports, and the production build's route analysis rejects
 * anything else (caught by the batch-tail preview build).
 */
export const PRESENCE_HEARTBEAT_RATE_LIMIT = { limit: 15, windowSeconds: 60 } as const;

export function presenceHeartbeatLimitKey(token: string): string {
	return `limits:presence:${token}`;
}

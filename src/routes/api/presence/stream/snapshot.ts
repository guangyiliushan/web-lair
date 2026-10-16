import {
	readContentSlice,
	readSitePresence,
	type PresenceDeps
} from '$lib/server/services/presence';

/**
 * Snapshot assembly + SSE cadence for the presence stream (realtime R2). A
 * sibling module rather than exports of `+server.ts`: SvelteKit route modules
 * only allow +-prefixed exports, and the production build's route analysis
 * rejects anything else (caught by the batch-tail preview build).
 */

export const PRESENCE_SNAPSHOT_MS = 5_000;
/** Keepalive cadence in ticks (3 × 5s = 15s). */
export const PRESENCE_KEEPALIVE_TICKS = 3;

export interface PresenceSnapshot {
	/** Content scope (`?c=`): reader count + 20-bucket position histogram. */
	content?: { count: number; hist: number[] } | null;
	/** Admin-only, content scope: anonymous position dots (bucket indices). */
	dots?: number[] | null;
	/** Admin-only, site scope (no `?c=`) — the dashboard cards. */
	site?: number | null;
	day?: number | null;
	peak?: number | null;
}

/** One snapshot for the requested scope; null fields mean "unavailable". */
export async function snapshotFor(
	contentId: string | null,
	scope: { admin: boolean; dots: boolean },
	deps: PresenceDeps = {}
): Promise<PresenceSnapshot> {
	if (contentId !== null) {
		// Single read per tick (review finding): the slice carries count,
		// histogram AND the capped dots, so dots-on connections stop paying a
		// second full-key scan.
		const slice = await readContentSlice(contentId, deps);
		const snapshot: PresenceSnapshot = {
			content: slice === null ? null : { count: slice.count, hist: slice.histogram }
		};
		if (scope.dots) snapshot.dots = slice === null ? null : slice.dots;
		return snapshot;
	}
	const site = scope.admin ? await readSitePresence(deps) : null;
	return { site: site?.site ?? null, day: site?.day ?? null, peak: site?.peak ?? null };
}

import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { SLUG_TRACKER_TYPES, slugTrackers } from '$lib/server/db/system';

/** Tracker subject types (schema whitelist: post | tag | note | photo). */
export type SlugTrackerType = (typeof SLUG_TRACKER_TYPES)[number];

/**
 * Resolve a retired slug to its target row id via `slug_trackers` (ledger
 * §9.16.5; P3-b grill Q1). Trackers store the target row id — not another
 * slug — so resolution is always a single hop and chains cannot form: the
 * "≤3 hops" guidance is satisfied by construction, not by an iterator.
 * When several tracker rows share a slug, the newest one wins (created_at
 * DESC — same-transaction rows share the clock, so the uuidv7 id breaks
 * the tie; review finding).
 *
 * Visibility is the caller's concern: this maps slug → id only. Callers
 * must re-load the target through their own visibility predicate before
 * redirecting; an invisible target must 404, never redirect.
 */
export async function findSlugTargetId(
	type: SlugTrackerType,
	lang: string,
	slug: string
): Promise<string | null> {
	const [tracker] = await db
		.select({ targetId: slugTrackers.targetId })
		.from(slugTrackers)
		.where(
			and(eq(slugTrackers.type, type), eq(slugTrackers.lang, lang), eq(slugTrackers.slug, slug))
		)
		.orderBy(desc(slugTrackers.createdAt), desc(slugTrackers.id))
		.limit(1);

	return tracker?.targetId ?? null;
}

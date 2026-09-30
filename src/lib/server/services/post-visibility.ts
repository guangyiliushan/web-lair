import { and, inArray, lte, type SQL } from 'drizzle-orm';
import { posts } from '$lib/server/db/content';

/**
 * Publish visibility, in one place (ledger §9.1). The public read side shows
 * `published` rows plus `scheduled` rows whose `published_at` has passed —
 * scheduling is judged lazily at read time, so no state flip is needed to
 * "go live". `draft`, `trash` and rows without a past `published_at` stay
 * hidden (that includes the odd `published` + future timestamp combination,
 * which the editor never writes).
 */
export const VISIBLE_POST_STATUSES = ['published', 'scheduled'] as const;

/** SQL condition for `posts` rows the public read side may show right now. */
export function visiblePostCondition(now: Date = new Date()): SQL<unknown> {
	// `and()` widens to SQL | undefined only for dynamic operand lists; two
	// fixed operands always produce a condition.
	return and(
		inArray(posts.status, [...VISIBLE_POST_STATUSES]),
		lte(posts.publishedAt, now)
	) as SQL<unknown>;
}

/** In-memory mirror of {@link visiblePostCondition}, for tests and row checks. */
export function isPostVisible(
	row: { status: string; publishedAt: Date | null },
	now: Date = new Date()
): boolean {
	return (
		(VISIBLE_POST_STATUSES as readonly string[]).includes(row.status) &&
		row.publishedAt !== null &&
		row.publishedAt <= now
	);
}

import { and, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import { notes } from '$lib/server/db/content';

/**
 * Publish visibility, in one place (mirror of `post-visibility.ts`; notes
 * plan §2.1): the public read side shows `published` rows plus `scheduled`
 * rows whose `published_at` has passed - scheduling is judged lazily at read
 * time, so no state flip is needed to "go live". `draft`, `private` and
 * `trash` stay hidden.
 *
 * Password-gated rows pass THIS predicate on purpose: their title and lock
 * show in lists (the gate only affects the detail read, ledger §13.9).
 * Feeds and the sitemap additionally exclude them (`feedableNoteCondition`),
 * and any caller that ships row content must null it for locked rows (see
 * `toNoteCard` in `notes.ts`).
 */
export const VISIBLE_NOTE_STATUSES = ['published', 'scheduled'] as const;

/** SQL condition for `notes` rows the public read side may show right now. */
export function visibleNoteCondition(now: Date = new Date()): SQL<unknown> {
	return and(
		inArray(notes.status, [...VISIBLE_NOTE_STATUSES]),
		lte(notes.publishedAt, now)
	) as SQL<unknown>;
}

/** In-memory mirror of {@link visibleNoteCondition}, for tests and row checks. */
export function isNoteVisible(
	row: { status: string; publishedAt: Date | null },
	now: Date = new Date()
): boolean {
	return (
		(VISIBLE_NOTE_STATUSES as readonly string[]).includes(row.status) &&
		row.publishedAt !== null &&
		row.publishedAt <= now
	);
}

/**
 * Visible AND not password-gated: the RSS/sitemap predicate (notes plan §3.3
 * exclusion face). Consumed by the distribution seams.
 */
export function feedableNoteCondition(now: Date = new Date()): SQL<unknown> {
	return and(visibleNoteCondition(now), isNull(notes.passwordHash)) as SQL<unknown>;
}

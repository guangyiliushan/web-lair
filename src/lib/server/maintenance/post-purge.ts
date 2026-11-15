import { and, eq, inArray } from 'drizzle-orm';
import type { db as appDb } from '../db/index.ts';
import { drafts, posts } from '../db/content/index.ts';
import { syncFileReferences } from '../services/file-references.ts';

/**
 * The database handle purge needs. A type-only import keeps the runtime free of
 * `$lib/server/db` (so the CLI can load this module under plain Node); callers
 * outside SvelteKit cast their handle (`db as never`).
 */
export type PurgePostDb = typeof appDb;

export type PurgePostFamilyResult = 'deleted' | 'not-found';

/**
 * Permanently delete a post and — when it is the source of a translation
 * family — every sibling in that family.
 *
 * Extracted from the admin posts route so the manual purge and the maintenance
 * job (`trash.purge`) share one delete primitive. A hand-written DELETE here
 * would hit `posts_group_source_uniq`: the self-FK's `SET NULL` turns every
 * sibling into a second "source" while the original row still exists, which is
 * the old 500. Ordering is therefore deliberate:
 *
 *   1. lock the row (`FOR UPDATE`) and, for a source, its siblings;
 *   2. drafts first — `drafts.ref_id` is polymorphic, no FK can cascade;
 *   3. siblings, then the row (comments/revisions/tags cascade);
 *   4. file references last, in the same lock order publish/discard use.
 */
export async function purgePostFamily(
	database: PurgePostDb,
	id: string
): Promise<PurgePostFamilyResult> {
	return database.transaction(async (tx) => {
		const [row] = await tx
			.select({
				id: posts.id,
				translationGroup: posts.translationGroup,
				translatedFromPostId: posts.translatedFromPostId
			})
			.from(posts)
			.where(eq(posts.id, id))
			.limit(1)
			.for('update');
		if (!row) return 'not-found';

		const siblings =
			row.translatedFromPostId === null
				? (
						await tx
							.select({ id: posts.id })
							.from(posts)
							.where(eq(posts.translationGroup, row.translationGroup))
							.for('update')
					)
						.map((member) => member.id)
						.filter((memberId) => memberId !== row.id)
				: [];

		const draftRows = await tx
			.delete(drafts)
			.where(and(eq(drafts.refType, 'post'), inArray(drafts.refId, [row.id, ...siblings])))
			.returning({ id: drafts.id });
		for (const memberId of siblings) {
			await tx.delete(posts).where(eq(posts.id, memberId));
		}
		await tx.delete(posts).where(eq(posts.id, row.id));
		for (const draft of draftRows) {
			await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
		}
		for (const memberId of siblings) {
			await syncFileReferences(tx, { type: 'post', id: memberId }, []);
		}
		await syncFileReferences(tx, { type: 'post', id: row.id }, []);
		return 'deleted';
	});
}

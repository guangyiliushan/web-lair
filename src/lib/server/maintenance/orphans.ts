import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { comments } from '../db/content/comment.schema.ts';
import { drafts } from '../db/content/draft.schema.ts';
import { notes } from '../db/content/note.schema.ts';
import { pages } from '../db/content/page.schema.ts';
import { posts } from '../db/content/post.schema.ts';
import { fileReferences } from '../db/system/file-reference.schema.ts';
import { syncFileReferences } from '../services/file-references.ts';

/**
 * Orphan sweep (M5 / ledger §9.1): `file_references` and `drafts` have a
 * polymorphic `ref_id`, so no foreign key can cascade when the target row is
 * deleted out-of-band (a direct SQL delete, a failed publish, an old bug).
 *
 * Rules (M5 D4):
 *   - file references to a missing target go through `syncFileReferences` with
 *     an empty key list. A raw DELETE would bypass the lock order and leave
 *     `files.status` stale; the sync also detaches the file when it was the
 *     last reference. Reversible: `pnpm db:backfill-refs` rebuilds from content.
 *   - drafts are deleted only when the target is missing AND the draft is older
 *     than the grace window (default 30 days). The draft may be the last copy of
 *     the text, so the window is the safety net.
 *   - `moments.ref_type/ref_id` are deliberately out of scope: nothing writes
 *     them yet, so a delete predicate there would be guesswork.
 *   - `translations` / `summaries` are covered by FK CASCADE, not by this job.
 *
 * The db handle is injected (no `$lib/server/db` import) so the same module
 * loads under plain Node from `scripts/jobs/orphans-purge.ts`.
 */
export const DRAFT_ORPHAN_GRACE_DAYS = 30;

export interface OrphanPurgeOptions {
	draftGraceDays?: number;
	dryRun?: boolean;
	now?: Date;
}

export interface OrphanPurgeResult {
	dryRun: boolean;
	draftGraceDays: number;
	/** (ref_type, ref_id) groups whose target row no longer exists. */
	refGroups: number;
	/** file_references rows inside those groups (deleted on a real run). */
	refRows: number;
	/** Orphan drafts past the grace window (deleted on a real run). */
	drafts: number;
	/** Kept for the receipt: moments are intentionally out of scope. */
	skippedMoments: true;
}

export type OrphansDb = Pick<PostgresJsDatabase<Record<string, never>>, 'transaction'>;

export interface OrphanPurgeDeps {
	db: OrphansDb;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeGraceDays(value: number | undefined): number {
	const days = Math.trunc(value ?? DRAFT_ORPHAN_GRACE_DAYS);
	if (!Number.isFinite(days) || days < 0) {
		throw new Error('draftGraceDays must be a non-negative integer');
	}
	return days;
}

/** Groups of file references whose polymorphic target no longer exists. */
function orphanRefGroupsQuery() {
	return sql`
		select ref_type, ref_id, count(*)::int as n
		from ${fileReferences}
		where ref_id is not null and (
			(ref_type = 'post' and not exists (select 1 from ${posts} t where t.id = ${fileReferences.refId}))
			or (ref_type = 'note' and not exists (select 1 from ${notes} t where t.id = ${fileReferences.refId}))
			or (ref_type = 'page' and not exists (select 1 from ${pages} t where t.id = ${fileReferences.refId}))
			or (ref_type = 'comment' and not exists (select 1 from ${comments} t where t.id = ${fileReferences.refId}))
			or (ref_type = 'draft' and not exists (select 1 from ${drafts} t where t.id = ${fileReferences.refId}))
		)
		group by ref_type, ref_id
	`;
}

/** Orphan drafts past the grace window (the target row is gone). */
function orphanDraftsQuery(cutoff: Date) {
	return sql`
		select d.id
		from ${drafts} d
		where d.ref_id is not null
			and coalesce(d.updated_at, d.created_at) < ${cutoff.toISOString()}::timestamptz
			and (
				(d.ref_type = 'post' and not exists (select 1 from ${posts} t where t.id = d.ref_id))
				or (d.ref_type = 'note' and not exists (select 1 from ${notes} t where t.id = d.ref_id))
				or (d.ref_type = 'page' and not exists (select 1 from ${pages} t where t.id = d.ref_id))
			)
	`;
}

/**
 * Delete (or, with `dryRun`, only count) orphan file references and drafts.
 * Idempotent: a second run finds nothing.
 */
export async function purgeOrphans(
	options: OrphanPurgeOptions,
	deps: OrphanPurgeDeps
): Promise<OrphanPurgeResult> {
	const draftGraceDays = normalizeGraceDays(options.draftGraceDays);
	const dryRun = options.dryRun === true;
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - draftGraceDays * DAY_MS);

	return deps.db.transaction(async (tx) => {
		const refGroups = (await tx.execute(orphanRefGroupsQuery())) as unknown as {
			ref_type: string;
			ref_id: string;
			n: number;
		}[];
		const orphanDrafts = (await tx.execute(orphanDraftsQuery(cutoff))) as unknown as {
			id: string;
		}[];

		const refRows = refGroups.reduce((sum, group) => sum + Number(group.n), 0);

		if (!dryRun) {
			for (const group of refGroups) {
				await syncFileReferences(
					tx as never,
					{
						type: group.ref_type as 'post' | 'note' | 'page' | 'comment' | 'draft',
						id: group.ref_id
					},
					[]
				);
			}
			for (const draft of orphanDrafts) {
				// Clear the draft's own file references before the row disappears,
				// otherwise they become orphans on the next run.
				await syncFileReferences(tx as never, { type: 'draft', id: draft.id }, []);
				await tx.delete(drafts).where(eq(drafts.id, draft.id));
			}
		}

		return {
			dryRun,
			draftGraceDays,
			refGroups: refGroups.length,
			refRows,
			drafts: orphanDrafts.length,
			skippedMoments: true as const
		};
	});
}

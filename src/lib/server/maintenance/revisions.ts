import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { postRevisions } from '../db/content/post-revision.schema.ts';

/**
 * Publish-time snapshots are capped per post: every publish
 * appends one revision, so an often-republished article would otherwise grow
 * without bound. The newest {@link REVISION_KEEP_PER_POST} stay; older rows are
 * deleted by the `revisions.prune` job (or the CLI with `--dry-run`).
 *
 * The db handle is injected (no `$lib/server/db` import) so the same module
 * loads under plain Node from `scripts/jobs/revisions-prune.ts`.
 */
export const REVISION_KEEP_PER_POST = 20;

export interface PruneRevisionsOptions {
	/** Override the per-post cap; must be a positive integer. */
	keep?: number;
	dryRun?: boolean;
}

export interface PruneRevisionsResult {
	keep: number;
	dryRun: boolean;
	/** Rows beyond the cap (the delete count on a real run). */
	matched: number;
	deleted: number;
}

/** Only the verb prune needs; matches the job module's narrow seam. */
export type RevisionsDb = Pick<PostgresJsDatabase<Record<string, never>>, 'execute'>;

export interface PruneRevisionsDeps {
	db: RevisionsDb;
}

/** Ids past the cap: rank each post's revisions newest-first, keep the top N. */
function staleRevisionIds(keep: number) {
	return sql`
		select id from (
			select
				id,
				row_number() over (
					partition by ${postRevisions.postId}
					order by ${postRevisions.version} desc
				) as rn
			from ${postRevisions}
		) ranked
		where rn > ${keep}
	`;
}

function normalizeKeep(keep: number | undefined): number {
	const value = Math.trunc(keep ?? REVISION_KEEP_PER_POST);
	if (!Number.isFinite(value) || value < 1) {
		throw new Error('keep must be a positive integer');
	}
	return value;
}

/**
 * Delete (or, with `dryRun`, only count) revisions beyond the per-post cap.
 * Idempotent on a fixed tree: a second run finds nothing to delete.
 */
export async function pruneRevisions(
	options: PruneRevisionsOptions,
	deps: PruneRevisionsDeps
): Promise<PruneRevisionsResult> {
	const keep = normalizeKeep(options.keep);
	const dryRun = options.dryRun === true;

	if (dryRun) {
		const rows = (await deps.db.execute(
			sql`select count(*)::int as n from (${staleRevisionIds(keep)}) stale`
		)) as unknown as { n: number }[];
		const matched = Number(rows[0]?.n ?? 0);
		return { keep, dryRun, matched, deleted: 0 };
	}

	const rows = (await deps.db.execute(
		sql`delete from ${postRevisions} where id in (${staleRevisionIds(keep)}) returning id`
	)) as unknown as unknown[];
	const deleted = rows.length;
	return { keep, dryRun, matched: deleted, deleted };
}

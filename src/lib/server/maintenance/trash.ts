import { sql } from 'drizzle-orm';
import type { db as appDb } from '../db/index.ts';
import { purgePostFamily } from './post-purge.ts';

/**
 * Trash retention: the admin list's trash is the first of
 * the two deliberate delete steps, and the row carries no `trashed_at` column.
 * The age proxy is `updated_at` — the status action writes it, and today no
 * other code path writes a trashed post's row (edits go to `drafts`).
 *
 * Family guard (D3): trashing a source row only hides the group head; a sibling
 * translation can still be `published`. Deleting the family then would silently
 * drop a published language, so this sweep deletes a family only when **every**
 * member is in the trash; mixed families are counted and skipped.
 *
 * No schedule by default: the service is exposed as
 * a CLI and a manual job. `ensure-job-schedules` deliberately does not seed it.
 */
export const TRASH_GRACE_DAYS = 30;

export interface PurgeTrashOptions {
	graceDays?: number;
	dryRun?: boolean;
	now?: Date;
}

export interface PurgeTrashResult {
	dryRun: boolean;
	graceDays: number;
	/** Trashed source families older than the grace window. */
	candidates: number;
	/** Families whose every member is trashed (deleted on a real run). */
	deletedFamilies: number;
	/** Posts in those families. */
	deletedPosts: number;
	/** Candidates skipped because at least one member is not trashed. */
	skippedMixedFamily: number;
}

/** The purge primitive and the candidate queries share one handle type. */
export type TrashDb = typeof appDb;

export interface PurgeTrashDeps {
	db: TrashDb;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeGraceDays(value: number | undefined): number {
	const days = Math.trunc(value ?? TRASH_GRACE_DAYS);
	if (!Number.isFinite(days) || days < 0) {
		throw new Error('graceDays must be a non-negative integer');
	}
	return days;
}

/** Trashed source rows past the grace window (one row per family head). */
function candidateFamiliesQuery(cutoffIso: string) {
	return sql`
		select p.id, p.translation_group
		from posts p
		where p.translated_from_post_id is null
			and p.status = 'trash'
			and coalesce(p.updated_at, p.created_at) < ${cutoffIso}::timestamptz
		order by p.updated_at asc nulls last
	`;
}

/** Member counts for one translation group. */
function familyCountsQuery(group: string) {
	return sql`
		select
			count(*)::int as total,
			count(*) filter (where status <> 'trash')::int as non_trash
		from posts
		where translation_group = ${group}
	`;
}

/**
 * Delete (or, with `dryRun`, only count) trashed families past the grace
 * window. Uses `purgePostFamily`, so drafts / references / siblings follow the
 * same path as a manual purge.
 */
export async function purgeTrashedPosts(
	options: PurgeTrashOptions,
	deps: PurgeTrashDeps
): Promise<PurgeTrashResult> {
	const graceDays = normalizeGraceDays(options.graceDays);
	const dryRun = options.dryRun === true;
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - graceDays * DAY_MS).toISOString();

	const candidates = (await deps.db.execute(candidateFamiliesQuery(cutoff))) as unknown as {
		id: string;
		translation_group: string;
	}[];

	let deletedFamilies = 0;
	let deletedPosts = 0;
	let skippedMixedFamily = 0;

	for (const candidate of candidates) {
		const [counts] = (await deps.db.execute(
			familyCountsQuery(candidate.translation_group)
		)) as unknown as { total: number; non_trash: number }[];
		const total = Number(counts?.total ?? 0);
		if (total === 0) continue; // the family vanished between queries
		if (Number(counts?.non_trash ?? 0) > 0) {
			skippedMixedFamily++;
			continue;
		}
		if (!dryRun) {
			const result = await purgePostFamily(deps.db, candidate.id);
			if (result === 'not-found') continue;
		}
		deletedFamilies++;
		deletedPosts += total;
	}

	return {
		dryRun,
		graceDays,
		candidates: candidates.length,
		deletedFamilies,
		deletedPosts,
		skippedMixedFamily
	};
}

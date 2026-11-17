import { and, eq, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { linkPrechecks } from '../db/content/link-precheck.schema.ts';
import { links } from '../db/content/link.schema.ts';

/**
 * Outdated-link pruning: rows that
 * lost their site stay in the public loss zone for `friends.checks.graceDays`
 * and are then deleted. The admin's `purgeOutdated` is the manual "clean now"
 * switch and keeps its all-outdated predicate; this module is the scheduled
 * grace-period path, exposed as a CLI for now.
 *
 * The db handle is injected (no `$lib/server/db` import) so the same module
 * loads under plain Node from `scripts/jobs/links-prune.ts`.
 */

export interface PruneOptions {
	/** From `friends.checks.graceDays` unless the CLI overrides it. */
	graceDays: number;
	dryRun?: boolean;
	now?: Date;
}

/**
 * Rejected/banned applications lose their contact address after this window
 * (data minimisation). The public policy renders the same constant, so the
 * promise and the job cannot drift apart.
 */
export const EMAIL_RETENTION_DAYS = 90;

/**
 * Precheck evidence is diagnostic, not an audit log. Keep the newest run per
 * link forever (the badge must survive) plus at most this many runs per link;
 * older rows are deleted by `links.prune`.
 */
export const PRECHECK_RETENTION_DAYS = 90;
export const PRECHECK_KEEP_PER_LINK = 20;

export interface PruneResult {
	graceDays: number;
	dryRun: boolean;
	/** Rows past the grace window (the delete count in a real run). */
	matched: number;
	deleted: number;
}

/** Only the two verbs prune needs; matches the job module's narrow seam. */
export type PruneDb = Pick<PostgresJsDatabase<Record<string, never>>, 'select' | 'delete'>;

export interface PruneDeps {
	db: PruneDb;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cutoff in application time (lost_since is written by the app clock too). */
export function pruneCutoff(graceDays: number, now: Date = new Date()): Date {
	return new Date(now.getTime() - graceDays * DAY_MS);
}

function prunePredicate(graceDays: number, now: Date) {
	return and(eq(links.status, 'outdated'), lte(links.lostSince, pruneCutoff(graceDays, now)));
}

/**
 * Delete (or, with `dryRun`, only count) outdated rows whose grace window has
 * expired. The comparison is `<=`: a row that reached the deadline is gone,
 * which keeps the CLI idempotent on a fixed clock.
 */
export async function pruneOutdated(options: PruneOptions, deps: PruneDeps): Promise<PruneResult> {
	const graceDays = Math.trunc(options.graceDays);
	if (!Number.isFinite(graceDays) || graceDays < 1) {
		throw new Error('graceDays must be a positive integer');
	}
	const dryRun = options.dryRun === true;
	const now = options.now ?? new Date();
	const dbx = deps.db;

	if (dryRun) {
		const [row] = await dbx
			.select({ count: sql<number>`count(*)::int` })
			.from(links)
			.where(prunePredicate(graceDays, now));
		return { graceDays, dryRun, matched: row?.count ?? 0, deleted: 0 };
	}

	const removed = await dbx
		.delete(links)
		.where(prunePredicate(graceDays, now))
		.returning({ id: links.id });
	return { graceDays, dryRun, matched: removed.length, deleted: removed.length };
}

export interface PrecheckPruneOptions {
	/** Rows older than this are eligible, except the newest per link. */
	days?: number;
	/** Hard cap per link (the newest run is always kept). */
	keep?: number;
}

/**
 * Delete old precheck runs. The newest run per link is never deleted, so a
 * pending row's badge cannot lose its only anchor; beyond that, rows older
 * than `days` or outside the newest `keep` are dropped. One statement, so
 * concurrent job runs cannot interleave half a retention pass.
 */
export async function prunePrecheckRuns(
	deps: PruneDeps,
	options: PrecheckPruneOptions = {}
): Promise<{ matched: number; deleted: number }> {
	const days = Math.trunc(options.days ?? PRECHECK_RETENTION_DAYS);
	const keep = Math.trunc(options.keep ?? PRECHECK_KEEP_PER_LINK);
	if (!Number.isFinite(days) || days < 1) {
		throw new Error('days must be a positive integer');
	}
	if (!Number.isFinite(keep) || keep < 1) {
		throw new Error('keep must be a positive integer');
	}
	const removed = await deps.db
		.delete(linkPrechecks)
		.where(
			sql`
			${linkPrechecks.id} in (
				select id from (
					select
						id,
						row_number() over (partition by link_id order by started_at desc) as rn,
						started_at
					from link_prechecks
				) ranked
				where rn > ${keep}
					or (rn > 1 and started_at < now() - make_interval(days => ${days}))
			)
		`
		)
		.returning({ id: linkPrechecks.id });
	return { matched: removed.length, deleted: removed.length };
}

export interface PruneArgs {
	dryRun: boolean;
	/** null = use `friends.checks.graceDays`. */
	graceDays: number | null;
}

export type PruneArgsResult = { ok: true; args: PruneArgs } | { ok: false; error: string };

/**
 * CLI parser: an unknown flag must stop the run (a typo must never turn a
 * dry-run into a delete).
 */
export function parsePruneArgs(argv: readonly string[]): PruneArgsResult {
	const args: PruneArgs = { dryRun: false, graceDays: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') {
			args.dryRun = true;
			continue;
		}
		if (arg === '--grace-days') {
			const raw = argv[i + 1];
			i += 1;
			if (raw === undefined) return { ok: false, error: '--grace-days needs a value' };
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 1 || value > 3650) {
				return { ok: false, error: '--grace-days must be an integer between 1 and 3650' };
			}
			args.graceDays = value;
			continue;
		}
		return { ok: false, error: `unknown argument: ${arg}` };
	}
	return { ok: true, args };
}

import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ProjectSyncProvider } from '../../utils/project-meta.ts';
import { pgErrorCode } from '../db/pg-error.ts';
import { projects } from '../db/content/project.schema.ts';
import { jobLockKey } from '../jobs/registry.ts';
import * as bitbucket from './adapters/bitbucket.ts';
import * as gitee from './adapters/gitee.ts';
import * as github from './adapters/github.ts';
import * as gitlab from './adapters/gitlab.ts';
import { ProjectsFetchError, type FetchJson } from './fetch.ts';
import { normalizeRepoUrl } from './normalize.ts';
import type {
	RawRepoMeta,
	RepoIdentity,
	SyncFailure,
	SyncFailureKind,
	SyncSummary,
	SyncTarget
} from './types.ts';

/**
 * The sync orchestrator (plan §3.5): target listing -> filter -> per-provider
 * upsert with the four write rules - new rows land `pending` with the
 * snapshot + prefill; existing rows get the snapshot ONLY (`status` and every
 * user field are never touched; rename refreshes `project_url`/`full_name`
 * because the API response is the source of truth); `rejected` rows are
 * skipped forever; refresh failures stamp `last_error_kind` without changing
 * status. Single-flight is the caller's job (drain per-job lock /
 * `PROJECT_SYNC_LOCK_KEY` for the CLI) - links-line precedent.
 */

/** Session advisory-lock key shared by drain, CLI and manual triggers. */
export const PROJECT_SYNC_LOCK_KEY = jobLockKey('projects.sync');

export type SyncDb = Pick<
	PostgresJsDatabase<Record<string, never>>,
	'select' | 'insert' | 'update'
>;

export interface SyncLogger {
	info(line: string): void;
	warn(line: string): void;
	error(line: string): void;
}

export interface RunSyncOptions {
	db: SyncDb;
	targets: SyncTarget[];
	logger: SyncLogger;
	dryRun?: boolean;
	/** Refresh specific rows by id (CLI `--refresh-ids`); skips target listing. */
	refreshIds?: string[];
	now?: () => Date;
	/** Injectable transport (tests stub this; defaults to the real fetcher). */
	fetchJson?: FetchJson;
}

interface Adapter {
	fetchUserRepos(
		account: string,
		deps: { fetchJson?: FetchJson }
	): Promise<{ repos: RawRepoMeta[]; rateLimited: boolean; truncated: boolean }>;
	fetchRepo(identity: RepoIdentity, deps: { fetchJson?: FetchJson }): Promise<RawRepoMeta>;
}

const ADAPTERS: Record<ProjectSyncProvider, Adapter> = {
	github,
	gitlab,
	gitee,
	bitbucket
};

/** Classified failures carry their kind; anything else is transport-level. */
function kindOf(err: unknown): SyncFailureKind {
	return err instanceof ProjectsFetchError ? err.kind : 'network';
}

/** Insert prefill: name = repo slug, description/homepage/avatar from the API. */
function insertValues(provider: ProjectSyncProvider, repo: RawRepoMeta, now: Date) {
	return {
		name: repo.fullName.split('/').pop() ?? repo.fullName,
		description: repo.description,
		provider,
		externalId: repo.externalId,
		// fullName / projectUrl arrive via the snapshot spread below.
		previewUrl: repo.homepage,
		avatar: repo.avatar,
		...snapshotValues(repo, now)
	};
}

/**
 * Snapshot-only update (§2.8): language / stars / pushed_at / archived /
 * fork / last_synced_at / last_error_kind plus the rename pair. User fields
 * (name / description / preview_url / doc_url / avatar / sort_order /
 * status) must never appear here.
 */
function snapshotValues(repo: RawRepoMeta, now: Date) {
	return {
		language: repo.language,
		stars: repo.stars,
		pushedAt: repo.pushedAt,
		archived: repo.archived,
		fork: repo.fork,
		projectUrl: repo.projectUrl,
		fullName: repo.fullName,
		lastSyncedAt: now,
		lastErrorKind: null
	};
}

function summaryLine(summary: SyncSummary): string {
	return `added=${summary.added} updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}${summary.dryRun ? ' (dry-run)' : ''}`;
}

export async function runSync(options: RunSyncOptions): Promise<SyncSummary> {
	const { db, logger } = options;
	const dryRun = options.dryRun === true;
	const now = options.now ?? (() => new Date());
	const summary: SyncSummary = {
		dryRun,
		targets: 0,
		added: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		failures: []
	};
	const addFailure = (failure: SyncFailure): void => {
		summary.failed += 1;
		summary.failures.push(failure);
		logger.warn(
			`[projects] ${failure.provider}/${failure.account}${failure.repo ? `/${failure.repo}` : ''}: ${failure.kind}`
		);
	};

	if (options.refreshIds && options.refreshIds.length > 0) {
		await refreshByIds({ ...options, dryRun, now }, summary, addFailure);
		logger.info(`[projects] refresh done: ${summaryLine(summary)}`);
		return summary;
	}

	for (const target of options.targets) {
		summary.targets += 1;
		const adapter = ADAPTERS[target.provider];
		let listed: { repos: RawRepoMeta[]; rateLimited: boolean; truncated: boolean };
		try {
			listed = await adapter.fetchUserRepos(target.account, { fetchJson: options.fetchJson });
		} catch (err) {
			addFailure({
				provider: target.provider,
				account: target.account,
				repo: null,
				kind: kindOf(err)
			});
			continue;
		}
		if (listed.rateLimited) {
			// Upsert what was fetched; the account is done for this run (§3.4).
			addFailure({
				provider: target.provider,
				account: target.account,
				repo: null,
				kind: 'rate_limited'
			});
		}
		if (listed.truncated) {
			// Page-cap stop with more pages pending: loud, not silent
			// (review 2026-10-08).
			logger.warn(
				`[projects] ${target.provider}/${target.account}: repo list truncated at the pagination cap`
			);
		}
		const candidates: RawRepoMeta[] = [];
		for (const repo of listed.repos) {
			if (repo.fork) continue;
			if (!repo.fullName || !repo.projectUrl || !repo.externalId) {
				addFailure({
					provider: target.provider,
					account: target.account,
					repo: null,
					kind: 'parse'
				});
				continue;
			}
			candidates.push(repo);
		}

		const existingRows =
			candidates.length > 0
				? await db
						.select({
							id: projects.id,
							externalId: projects.externalId,
							status: projects.status
						})
						.from(projects)
						.where(
							and(
								eq(projects.provider, target.provider),
								inArray(
									projects.externalId,
									candidates.map((repo) => repo.externalId)
								)
							)
						)
				: [];
		const byExternalId = new Map(existingRows.map((row) => [row.externalId ?? '', row]));

		for (const repo of candidates) {
			const existing = byExternalId.get(repo.externalId);
			if (existing) {
				if (existing.status === 'rejected') {
					// Permanent memory: a rejected row is never resurrected (§3.5-3).
					summary.skipped += 1;
					continue;
				}
				if (!dryRun) {
					await db
						.update(projects)
						.set(snapshotValues(repo, now()))
						.where(eq(projects.id, existing.id));
				}
				summary.updated += 1;
				continue;
			}
			if (dryRun) {
				summary.added += 1;
				continue;
			}
			try {
				await db.insert(projects).values(insertValues(target.provider, repo, now()));
				summary.added += 1;
			} catch (err) {
				// Unique race (concurrent insert beat us): fall through to the
				// snapshot update so the row is still refreshed.
				if (pgErrorCode(err) !== '23505') throw err;
				const [row] = await db
					.select({ id: projects.id, status: projects.status })
					.from(projects)
					.where(
						and(eq(projects.provider, target.provider), eq(projects.externalId, repo.externalId))
					)
					.limit(1);
				if (row && row.status === 'rejected') {
					// The race winner was rejected before we got here: rejected
					// rows never take snapshot updates (same rule as the scan).
					summary.skipped += 1;
				} else if (row) {
					await db.update(projects).set(snapshotValues(repo, now())).where(eq(projects.id, row.id));
					summary.updated += 1;
				} else {
					throw err;
				}
			}
		}
	}
	logger.info(`[projects] sync done: ${summaryLine(summary)}`);
	return summary;
}

/**
 * Refresh mode (§3.5-4): re-GET selected rows one by one; 404 stamps
 * `not_found` without touching the review status; other kinds are stamped
 * the same way (this row was explicitly checked, so its ledger entry is the
 * point).
 */
async function refreshByIds(
	options: RunSyncOptions & { dryRun: boolean; now: () => Date },
	summary: SyncSummary,
	addFailure: (failure: SyncFailure) => void
): Promise<void> {
	const { db, dryRun, now } = options;
	// Duplicate ids collapse: one fetch per row (review 2026-10-08).
	const ids = [...new Set(options.refreshIds ?? [])];
	/** Accounts that hit a rate limit this run - remaining rows skip (plan §3.4). */
	const rateLimitedAccounts = new Set<string>();
	const rows = await db
		.select({
			id: projects.id,
			provider: projects.provider,
			projectUrl: projects.projectUrl,
			status: projects.status
		})
		.from(projects)
		.where(inArray(projects.id, ids));
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const id of ids) {
		const row = byId.get(id);
		if (!row) {
			summary.skipped += 1;
			continue;
		}
		if (row.status === 'rejected') {
			// Permanent memory: rejected rows are never touched by sync,
			// refresh included (review 2026-10-08, §3.5).
			summary.skipped += 1;
			continue;
		}
		const identity = normalizeRepoUrl(row.projectUrl);
		if (!identity || identity.provider !== row.provider) {
			// site / other rows are not syncable, and a URL whose provider
			// no longer matches the row would refresh the wrong repository
			// (review 2026-10-08) - skip both.
			summary.skipped += 1;
			continue;
		}
		// Case-insensitive account bucket: providers treat account names
		// case-insensitively, so case variants share one breaker (review
		// 2026-10-08).
		const accountKey = `${identity.provider}/${identity.account.toLowerCase()}`;
		if (rateLimitedAccounts.has(accountKey)) {
			// Plan §3.4: after a rate limit, the rest of this run's requests
			// for the account are abandoned (review 2026-10-08).
			summary.skipped += 1;
			continue;
		}
		const adapter = ADAPTERS[identity.provider as ProjectSyncProvider];
		try {
			const repo = await adapter.fetchRepo(identity, { fetchJson: options.fetchJson });
			if (!dryRun) {
				await db.update(projects).set(snapshotValues(repo, now())).where(eq(projects.id, id));
			}
			summary.updated += 1;
		} catch (err) {
			const kind = kindOf(err);
			addFailure({
				provider: identity.provider,
				account: identity.account,
				repo: identity.repo,
				kind
			});
			if (kind === 'rate_limited') {
				rateLimitedAccounts.add(accountKey);
			}
			if (!dryRun) {
				await db
					.update(projects)
					.set({ lastErrorKind: kind, lastSyncedAt: now() })
					.where(eq(projects.id, id));
			}
		}
	}
}

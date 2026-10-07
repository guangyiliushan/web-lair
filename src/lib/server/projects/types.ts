import type { ProjectSyncProvider } from '../../utils/project-meta.ts';

/**
 * Projects-line sync vocabulary (projects plan §3.1): identities, raw
 * snapshots, the five failure kinds and the run summary. Dependency-free
 * apart from the meta module so the whole `projects/**` graph stays loadable
 * under plain Node type stripping (drain + CLI).
 */

/** One configured sync target (`projects.sync_targets` element). */
export interface SyncTarget {
	provider: ProjectSyncProvider;
	account: string;
}

/**
 * Parsed repository identity from a URL (normalize.ts output). `account` is
 * the owner / namespace / workspace and `repo` the final path segment; for
 * GitLab the namespace may itself contain slashes (subgroups).
 */
export interface RepoIdentity {
	provider: ProjectSyncProvider;
	account: string;
	repo: string;
}

/** API snapshot mapped onto our columns (plan §3.2); user fields never here. */
export interface RawRepoMeta {
	/** Platform-stable id, unified as string (Bitbucket braces stripped). */
	externalId: string;
	/** `owner/repo` or host-qualified path. */
	fullName: string;
	/** Canonical repository page URL. */
	projectUrl: string;
	/** Repo `homepage` / `website`; used only to prefill an empty preview_url. */
	homepage: string | null;
	avatar: string | null;
	description: string | null;
	language: string | null;
	stars: number | null;
	pushedAt: Date | null;
	archived: boolean;
	fork: boolean;
}

/** The five failure kinds written to `projects.last_error_kind` (§3.3). */
export type SyncFailureKind = 'not_found' | 'rate_limited' | 'auth' | 'network' | 'parse';

export interface SyncFailure {
	provider: ProjectSyncProvider;
	account: string;
	/** Null for whole-account (list) failures. */
	repo: string | null;
	kind: SyncFailureKind;
}

export interface SyncSummary {
	dryRun: boolean;
	/** Targets attempted this run. */
	targets: number;
	added: number;
	updated: number;
	skipped: number;
	failed: number;
	failures: SyncFailure[];
}

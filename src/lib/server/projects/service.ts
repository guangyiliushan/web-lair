import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { projects } from '$lib/server/db/content';
import { jobRuns } from '$lib/server/db/system';
import { enqueueJob } from '../jobs/queue.ts';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { pgErrorCode } from '../db/pg-error.ts';
import { safeHttpUrl } from '$lib/utils/url-safety';
import {
	PROJECT_STATUSES,
	isProjectSyncProvider,
	type ProjectProvider,
	type ProjectStatus
} from '$lib/utils/project-meta';
import { normalizeRepoUrl } from './normalize.ts';
import { providerForImport, resolveImportMetadata } from './import-url.ts';
import type { RawRepoMeta, RepoIdentity, SyncTarget } from './types.ts';

/**
 * Admin-side projects service (plan §4): list + counts, the four-value state
 * machine, field edits with the write-side URL scheme guard, transactional
 * reordering, URL import prefill (adapter first, OG fallback) and the sync
 * enqueue/status pair. Route handlers stay thin; every rule lives here so it
 * is unit-testable and shared with the e2e acceptance.
 */

export class ProjectsServiceError extends Error {
	readonly code: 'not_found' | 'invalid' | 'busy';

	constructor(code: 'not_found' | 'invalid' | 'busy', message: string) {
		super(message);
		this.name = 'ProjectsServiceError';
		this.code = code;
	}
}

/** §4.2 transition table; anything not listed is refused. */
const ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
	pending: ['published', 'rejected'],
	published: ['hidden', 'rejected'],
	hidden: ['published', 'rejected'],
	rejected: ['pending']
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
	return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface AdminProjectRow {
	id: string;
	name: string;
	description: string | null;
	provider: string;
	externalId: string | null;
	projectUrl: string | null;
	previewUrl: string | null;
	docUrl: string | null;
	avatar: string | null;
	language: string | null;
	stars: number | null;
	pushedAt: Date | null;
	archived: boolean;
	fork: boolean;
	status: string;
	sortOrder: number;
	lastSyncedAt: Date | null;
	lastErrorKind: string | null;
}

export interface ProjectCounts {
	all: number;
	pending: number;
	published: number;
	hidden: number;
	rejected: number;
}

const EMPTY_COUNTS: ProjectCounts = { all: 0, pending: 0, published: 0, hidden: 0, rejected: 0 };

/** Status-tab counts for the header (one grouped query). */
export async function projectCounts(): Promise<ProjectCounts> {
	const rows = await db
		.select({ status: projects.status, count: sql<number>`count(*)`.mapWith(Number) })
		.from(projects)
		.groupBy(projects.status);
	const counts = { ...EMPTY_COUNTS };
	for (const row of rows) {
		if (row.status in counts) counts[row.status as ProjectStatus] = row.count;
		counts.all += row.count;
	}
	return counts;
}

export const ADMIN_PROJECT_COLUMNS = {
	id: projects.id,
	name: projects.name,
	description: projects.description,
	provider: projects.provider,
	externalId: projects.externalId,
	projectUrl: projects.projectUrl,
	previewUrl: projects.previewUrl,
	docUrl: projects.docUrl,
	avatar: projects.avatar,
	language: projects.language,
	stars: projects.stars,
	pushedAt: projects.pushedAt,
	archived: projects.archived,
	fork: projects.fork,
	status: projects.status,
	sortOrder: projects.sortOrder,
	lastSyncedAt: projects.lastSyncedAt,
	lastErrorKind: projects.lastErrorKind
} as const;

/**
 * List rows for the admin table (streamed by the route as a deferred
 * promise). URLs stay as stored here; the public grid applies the http(s)
 * filter on its own read path (`safeHttpUrl`), and the admin edit form
 * re-validates on save - the admin surface renders no href from these values.
 */
export function listProjects(filter: ProjectStatus | 'all'): Promise<AdminProjectRow[]> {
	return db
		.select(ADMIN_PROJECT_COLUMNS)
		.from(projects)
		.where(filter === 'all' ? undefined : eq(projects.status, filter))
		.orderBy(asc(projects.sortOrder), desc(projects.createdAt), desc(projects.id));
}

/** Bulk status transition (§4.2): one atomic conditional UPDATE - rows whose
 * current status does not allow the edge are skipped, concurrently-changed
 * rows are refused by the `status in (allowedFrom)` predicate (review: the
 * previous read-then-blind-write could commit a forbidden edge), and the
 * returning count is the true `updated`. */
export async function setProjectStatus(
	ids: string[],
	to: ProjectStatus
): Promise<{ updated: number; skipped: number }> {
	const allowedFrom = PROJECT_STATUSES.filter((from) => canTransition(from, to));
	const updated = await db
		.update(projects)
		.set({ status: to })
		.where(and(inArray(projects.id, ids), inArray(projects.status, allowedFrom)))
		.returning({ id: projects.id });
	return { updated: updated.length, skipped: ids.length - updated.length };
}

export interface ProjectEditFields {
	name: string;
	description: string | null;
	projectUrl: string;
	previewUrl: string | null;
	docUrl: string | null;
	avatar: string | null;
}

/**
 * Edit the user-owned fields (§2.8): name is required; every URL must be
 * empty/null or http(s) - the write-side half of the P render guard
 * (`$lib/utils/url-safety` is the single table for both sides).
 */
export async function updateProjectFields(id: string, fields: ProjectEditFields): Promise<void> {
	const name = fields.name.trim();
	if (name.length === 0) throw new ProjectsServiceError('invalid', 'name-required');
	const projectUrl = requireHttpUrl(fields.projectUrl);
	if (projectUrl === null) throw new ProjectsServiceError('invalid', 'url-required');
	const previewUrl = requireHttpUrl(fields.previewUrl);
	const docUrl = requireHttpUrl(fields.docUrl);
	const avatar = requireHttpUrl(fields.avatar);
	const [current] = await db
		.select({ provider: projects.provider, projectUrl: projects.projectUrl })
		.from(projects)
		.where(eq(projects.id, id))
		.limit(1);
	if (!current) throw new ProjectsServiceError('not_found', 'missing');
	try {
		const updated = await db
			.update(projects)
			.set({
				name,
				description: fields.description,
				// Repo-row URLs stay sync-owned: the edit dialog renders them
				// read-only, and a constructed POST must not rewrite them either
				// (closing review - create rechecks the platform identity, the
				// update path keeps the stored value).
				projectUrl: isProjectSyncProvider(current.provider)
					? current.projectUrl
					: normalizeUrlForWrite(current.provider, projectUrl),
				previewUrl,
				docUrl,
				avatar
			})
			.where(eq(projects.id, id))
			.returning({ id: projects.id });
		if (updated.length === 0) throw new ProjectsServiceError('not_found', 'missing');
	} catch (err) {
		if (pgErrorCode(err) === '23505') throw new ProjectsServiceError('invalid', 'duplicate');
		throw err;
	}
}

/** Shared by the edit and create paths; exported for the unit suite. */
export function requireHttpUrl(value: string | null): string | null {
	const trimmed = value === null ? null : value.trim();
	const clean = trimmed === '' ? null : trimmed;
	if (clean !== null && safeHttpUrl(clean) === null) {
		throw new ProjectsServiceError('invalid', 'bad-url');
	}
	return clean;
}

/** site/other links normalize (§2.8-4); four-platform rows keep the API URL. */
function normalizeUrlForWrite(provider: string, url: string): string {
	return provider === 'site' || provider === 'other' ? normalizeSiteUrl(url) : url;
}

export interface ProjectCreateFields extends ProjectEditFields {
	provider: ProjectProvider;
	/** Platform id / full name - present for rows created through a repo import (§4.4). */
	externalId?: string | null;
	fullName?: string | null;
}

/**
 * Manual create (§4.4): rows land `published` (你手输的 = 你要的). Plain
 * "new" is site/other; a four-platform row only arrives through the URL
 * import, which supplies the platform id (the dedup identity).
 */
export async function createProject(fields: ProjectCreateFields): Promise<{ id: string }> {
	const name = fields.name.trim();
	if (name.length === 0) throw new ProjectsServiceError('invalid', 'name-required');
	const projectUrl = requireHttpUrl(fields.projectUrl);
	if (projectUrl === null) throw new ProjectsServiceError('invalid', 'url-required');
	const externalId = fields.externalId?.trim() || null;
	if (isProjectSyncProvider(fields.provider)) {
		if (externalId === null) {
			throw new ProjectsServiceError('invalid', 'external-id-required');
		}
		// The URL must belong to the same platform, or the row could never
		// refresh (review: repo prefill with a hand-edited URL).
		const identity = normalizeRepoUrl(projectUrl);
		if (!identity || identity.provider !== fields.provider) {
			throw new ProjectsServiceError('invalid', 'identity-mismatch');
		}
	}
	try {
		const [row] = await db
			.insert(projects)
			.values({
				name,
				description: fields.description,
				provider: fields.provider,
				externalId: isProjectSyncProvider(fields.provider) ? externalId : null,
				fullName: fields.fullName?.trim() || null,
				projectUrl: normalizeUrlForWrite(fields.provider, projectUrl),
				previewUrl: requireHttpUrl(fields.previewUrl),
				docUrl: requireHttpUrl(fields.docUrl),
				avatar: requireHttpUrl(fields.avatar),
				status: 'published'
			})
			.returning({ id: projects.id });
		return { id: row.id };
	} catch (err) {
		if (pgErrorCode(err) === '23505') throw new ProjectsServiceError('invalid', 'duplicate');
		throw err;
	}
}

/** Transactional reorder (§4.1): the full list is locked (`FOR UPDATE`, one
 * consistent acquisition order - review: unlocked renumbering lost updates
 * and could deadlock) and renumbered 1..N; deadlock/serialization failures
 * surface as `busy`. */
export async function moveProject(id: string, move: 'up' | 'down' | 'top'): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			const rows = await tx
				.select({ id: projects.id })
				.from(projects)
				.orderBy(asc(projects.sortOrder), desc(projects.createdAt), desc(projects.id))
				.for('update');
			const index = rows.findIndex((row) => row.id === id);
			if (index === -1) throw new ProjectsServiceError('not_found', 'missing');
			const target =
				move === 'top'
					? 0
					: move === 'up'
						? Math.max(0, index - 1)
						: Math.min(rows.length - 1, index + 1);
			const [moved] = rows.splice(index, 1);
			rows.splice(target, 0, moved);
			for (let position = 0; position < rows.length; position += 1) {
				await tx
					.update(projects)
					.set({ sortOrder: position + 1 })
					.where(eq(projects.id, rows[position].id));
			}
		});
	} catch (err) {
		if (err instanceof ProjectsServiceError) throw err;
		if (pgErrorCode(err) === '40P01' || pgErrorCode(err) === '40001') {
			throw new ProjectsServiceError('busy', 'busy');
		}
		throw err;
	}
}

export async function deleteProjects(ids: string[]): Promise<number> {
	const deleted = await db
		.delete(projects)
		.where(inArray(projects.id, ids))
		.returning({ id: projects.id });
	return deleted.length;
}

export interface ImportPrefill {
	provider: ProjectProvider;
	name: string;
	description: string | null;
	projectUrl: string;
	previewUrl: string | null;
	avatar: string | null;
	externalId: string | null;
	fullName: string | null;
	/** Existing row (any status) that this URL would collide with. */
	existing: { id: string; status: string } | null;
}

/**
 * URL import prefill (§4.4): four platform URLs resolve through their
 * adapter, everything else through the OG scrape; both paths hand back form
 * prefill plus the "already exists (status X)" probe (identity for repos,
 * normalized URL for site/other rows, §2.8-4).
 */
export async function importPrefill(rawUrl: string): Promise<
	| { ok: true; prefill: ImportPrefill }
	| {
			ok: false;
			reason:
				'invalid-url' | 'blocked' | 'not_found' | 'rate_limited' | 'auth' | 'network' | 'parse';
	  }
> {
	const result = await resolveImportMetadata(rawUrl);
	if (!result.ok) return { ok: false, reason: result.reason };

	if (result.kind === 'repo') {
		const { identity, meta } = result;
		return {
			ok: true,
			prefill: {
				provider: identity.provider,
				name: repoNameFrom(meta),
				description: meta.description,
				projectUrl: meta.projectUrl,
				previewUrl: meta.homepage,
				avatar: meta.avatar,
				externalId: meta.externalId,
				fullName: meta.fullName,
				existing: await findExistingRepo(identity, meta)
			}
		};
	}

	const url = normalizeSiteUrl(result.url);
	return {
		ok: true,
		prefill: {
			provider: providerForImport(result),
			name: result.og.title ?? '',
			description: result.og.description,
			projectUrl: url,
			previewUrl: null,
			avatar: result.og.icon,
			externalId: null,
			fullName: null,
			existing: await findExistingSite(url)
		}
	};
}

function repoNameFrom(meta: RawRepoMeta): string {
	const segment = meta.fullName.split('/').filter(Boolean).at(-1);
	return segment ?? meta.fullName;
}

async function findExistingRepo(
	identity: RepoIdentity,
	meta: RawRepoMeta
): Promise<{ id: string; status: string } | null> {
	const [row] = await db
		.select({ id: projects.id, status: projects.status })
		.from(projects)
		.where(and(eq(projects.provider, identity.provider), eq(projects.externalId, meta.externalId)))
		.limit(1);
	return row ?? null;
}

async function findExistingSite(url: string): Promise<{ id: string; status: string } | null> {
	const [row] = await db
		.select({ id: projects.id, status: projects.status })
		.from(projects)
		.where(and(inArray(projects.provider, ['site', 'other']), eq(projects.projectUrl, url)))
		.limit(1);
	return row ?? null;
}

/**
 * Site/other main links normalize by host case + trailing slash (§2.8-4);
 * the fragment (hash) and any userinfo are dropped, queries are preserved
 * as-is (closing review: documented behavior).
 */
export function normalizeSiteUrl(raw: string): string {
	const parsed = new URL(raw);
	const host = parsed.host.toLowerCase();
	const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
	return `${parsed.protocol}//${host}${path}${parsed.search}`;
}

export function getSyncTargets(): Promise<SyncTarget[]> {
	return getOption('projects.sync_targets');
}

/** Registry-validated write (duplicate (provider, account) pairs throw). */
export async function setSyncTargets(targets: SyncTarget[]): Promise<void> {
	await setOption('projects.sync_targets', targets);
}

export function enqueueSync(): Promise<{ id: string; deduplicated: boolean }> {
	return enqueueJob(db, 'projects.sync', 'manual');
}

/** One row by id (deep link after "already exists" jumps; any status). */
export async function getProject(id: string): Promise<AdminProjectRow | null> {
	const [row] = await db
		.select(ADMIN_PROJECT_COLUMNS)
		.from(projects)
		.where(eq(projects.id, id))
		.limit(1);
	return row ?? null;
}

export interface SyncRunView {
	id: string;
	status: string;
	trigger: string;
	createdAt: Date;
	finishedAt: Date | null;
	result: Record<string, unknown> | null;
	error: string | null;
}

/** Latest `projects.sync` run for the "recent run" card (§4.1): newest
 * `createdAt` first (queued runs included - the card doubles as the enqueue
 * acknowledgement), `id` as the deterministic tiebreaker. */
export async function latestSyncRun(): Promise<SyncRunView | null> {
	const [row] = await db
		.select({
			id: jobRuns.id,
			status: jobRuns.status,
			trigger: jobRuns.trigger,
			createdAt: jobRuns.createdAt,
			finishedAt: jobRuns.finishedAt,
			result: jobRuns.result,
			error: jobRuns.error
		})
		.from(jobRuns)
		.where(eq(jobRuns.job, 'projects.sync'))
		.orderBy(desc(jobRuns.createdAt), desc(jobRuns.id))
		.limit(1);
	return row ?? null;
}

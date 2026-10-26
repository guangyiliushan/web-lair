import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { links } from '$lib/server/db/content/link.schema';
import { getOption } from '$lib/server/config/options-registry';
import { enqueueJob } from '$lib/server/jobs/queue';
import { LINK_STATUSES, type LinkStatus } from '$lib/utils/link-meta';
import { checkSite } from './check-site';
import { buildUserAgent, type FetchUnitDeps } from './fetch';
import {
	createRunRobotsOracle,
	deriveAcceptedHosts,
	deriveRowUpdate,
	linkWritePredicate,
	publicOrigin,
	ringSqlFragment,
	type LinkRowSnapshot
} from './job';
import { normalizeLinkUrl } from './normalize';

/**
 * Admin surface for the links line (L3, plan §5.3): the read side that feeds
 * the tabs/counts/drawer and the write side for the review matrix. The only
 * automatic transitions live in `deriveRowUpdate` (checker); manual ones are
 * declared here as `MANUAL_TRANSITIONS` so a route can never invent an edge.
 *
 * Error model: every user-fixable failure is a `LinkAdminError` code; the
 * route maps codes to Paraglide keys. Postgres constraint violations are
 * translated, never leaked (CHECK 3/5 and the two unique indexes are the
 * authority - the service only produces messages).
 */

/** Plan §5.3: one page of rows is enough at this scale; counts carry the total. */
export const LIST_LIMIT = 200;

/** G4: a second manual check on the same row inside a minute is a double-click. */
export const MANUAL_CHECK_COOLDOWN_MS = 60_000;

export type LinkAdminErrorCode =
	| 'missing'
	| 'stale'
	| 'bad-status'
	| 'name-required'
	| 'reason-required'
	| 'note-required'
	| 'bad-url'
	| 'subpath'
	| 'backlink-required'
	| 'url-taken'
	| 'name-taken'
	| 'not-checkable'
	| 'busy'
	| 'checks-disabled';

export class LinkAdminError extends Error {
	readonly code: LinkAdminErrorCode;

	constructor(code: LinkAdminErrorCode) {
		super(code);
		this.name = 'LinkAdminError';
		this.code = code;
	}
}

// ── Manual state machine (plan §3, manual edges only) ──────────────────────

export const MANUAL_TRANSITIONS = [
	['pending', 'approved'],
	['pending', 'rejected'],
	['approved', 'banned'],
	['outdated', 'banned'],
	['banned', 'approved']
] as const satisfies ReadonlyArray<readonly [LinkStatus, LinkStatus]>;

/** Action → the statuses it may start from (single source for the guards). */
export const MANUAL_ACTION_SOURCES: Record<ManualAction, readonly LinkStatus[]> = {
	approve: ['pending'],
	reject: ['pending'],
	ban: ['approved', 'outdated'],
	restore: ['banned']
};

export function canManualTransition(from: LinkStatus, to: LinkStatus): boolean {
	return MANUAL_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

export type ManualAction = 'approve' | 'reject' | 'ban' | 'restore';

export interface ManualTransitionInput {
	note?: string | null;
	reason?: string | null;
}

export interface ManualTransitionPatch {
	status: LinkStatus;
	reason: string | null;
	/** CHECK 4: only `outdated` may carry a value - ban must clear it. */
	lostSince: Date | null;
	checkEnabled?: boolean;
}

/**
 * Shared guard for `pending → approved` and `banned → approved`: a passing
 * backlink check, or an explicit note that is stored as `override: <note>`
 * (the table has no note column; approved rows never surface `reason`).
 */
function approvalReason(
	backlinkOk: boolean | null,
	note: string | null | undefined
): string | null {
	const trimmed = (note ?? '').trim();
	if (backlinkOk === true) return null;
	if (!trimmed) throw new LinkAdminError('note-required');
	return `override: ${trimmed}`;
}

export function planManualTransition(
	row: { status: LinkStatus; backlinkOk: boolean | null },
	action: ManualAction,
	input: ManualTransitionInput = {}
): ManualTransitionPatch {
	const note = input.note ?? null;
	const reason = (input.reason ?? '').trim();

	switch (action) {
		case 'approve': {
			// Restore owns the banned edge; approve is pending-only.
			if (!MANUAL_ACTION_SOURCES.approve.includes(row.status)) {
				throw new LinkAdminError('bad-status');
			}
			return {
				status: 'approved',
				reason: approvalReason(row.backlinkOk, note),
				lostSince: null
			};
		}
		case 'reject': {
			if (!MANUAL_ACTION_SOURCES.reject.includes(row.status)) {
				throw new LinkAdminError('bad-status');
			}
			if (!reason) throw new LinkAdminError('reason-required');
			return { status: 'rejected', reason, lostSince: null };
		}
		case 'ban': {
			if (!MANUAL_ACTION_SOURCES.ban.includes(row.status)) {
				throw new LinkAdminError('bad-status');
			}
			if (!reason) throw new LinkAdminError('reason-required');
			// Plan §3: ban also pauses checks and clears lost_since (CHECK 4).
			return { status: 'banned', reason, lostSince: null, checkEnabled: false };
		}
		case 'restore': {
			if (!MANUAL_ACTION_SOURCES.restore.includes(row.status)) {
				throw new LinkAdminError('bad-status');
			}
			return {
				status: 'approved',
				reason: approvalReason(row.backlinkOk, note),
				lostSince: null,
				// A restored row must be checked again - ban switched it off.
				checkEnabled: true
			};
		}
	}
}

// ── Derived badges (plan §2.5) ─────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface LinkBadgeRow {
	status: string;
	backlinkMissingStreak: number;
	lastErrorKind: string | null;
	lastOkAt: Date | null;
	lostSince: Date | null;
}

export interface LinkRowBadges {
	/** `backlink_missing_streak >= 2` on an approved/outdated row. */
	backlinkLost: boolean;
	/** WAF-blocked with no success for seven days. */
	blocked: boolean;
	/** Outdated row inside the last `graceDays - 7` window before prune. */
	purgeSoon: boolean;
	/** Whole days until prune (null unless outdated). */
	daysToPurge: number | null;
}

export function computeRowBadges(row: LinkBadgeRow, now: Date, graceDays: number): LinkRowBadges {
	const live = row.status === 'approved' || row.status === 'outdated';
	const backlinkLost = live && row.backlinkMissingStreak >= 2;
	const blocked =
		row.lastErrorKind === 'waf' &&
		(row.lastOkAt === null || now.getTime() - row.lastOkAt.getTime() >= 7 * DAY_MS);
	let daysToPurge: number | null = null;
	let purgeSoon = false;
	if (row.status === 'outdated' && row.lostSince) {
		const deadline = row.lostSince.getTime() + graceDays * DAY_MS;
		daysToPurge = Math.max(0, Math.ceil((deadline - now.getTime()) / DAY_MS));
		purgeSoon = now.getTime() >= deadline - 7 * DAY_MS;
	}
	return { backlinkLost, blocked, purgeSoon, daysToPurge };
}

/** Sort keys are hand-entered: keep them inside the integer the UI can show. */
export function clampSortOrder(value: number | null | undefined): number {
	if (value === null || value === undefined || !Number.isFinite(value)) return 0;
	return Math.min(9999, Math.max(0, Math.trunc(value)));
}

// ── Reads ──────────────────────────────────────────────────────────────────

const listSelection = {
	id: links.id,
	name: links.name,
	url: links.url,
	host: links.host,
	avatar: links.avatar,
	description: links.description,
	email: links.email,
	backlinkUrl: links.backlinkUrl,
	backlinkOk: links.backlinkOk,
	backlinkCheckedAt: links.backlinkCheckedAt,
	backlinkMissingStreak: links.backlinkMissingStreak,
	status: links.status,
	reason: links.reason,
	reviewedBy: links.reviewedBy,
	reviewedAt: links.reviewedAt,
	lastCheckedAt: links.lastCheckedAt,
	lastOkAt: links.lastOkAt,
	failStreak: links.failStreak,
	lastErrorKind: links.lastErrorKind,
	lostSince: links.lostSince,
	checkEnabled: links.checkEnabled,
	sortOrder: links.sortOrder,
	createdAt: links.createdAt,
	updatedAt: links.updatedAt,
	// Detail opens from the row: the ring is bounded (CHECK ≤10) and admin
	// lists cap at 200 rows, so shipping it with the row beats a second
	// round trip on every "details" click.
	recentChecks: links.recentChecks
} as const;

const detailSelection = listSelection;

export type LinkListRow = Awaited<ReturnType<typeof listLinks>>[number];
export type LinkDetailRow = Awaited<ReturnType<typeof getLink>>;

/**
 * Per-tab ordering, stable on purpose (plan §5.3 + list-view contract): every
 * order ends with the id so LIMIT can never return an unstable subset.
 * `reviewed_at` is nullable in the baseline - DESC would put NULLs first in
 * Postgres, so it is written out as `nulls last`.
 */
function orderFor(state: LinkStatus) {
	switch (state) {
		case 'approved':
			return [asc(links.sortOrder), asc(links.name), asc(links.id)];
		case 'pending':
			return [asc(links.createdAt), asc(links.id)];
		case 'outdated':
			return [asc(links.lostSince), asc(links.id)];
		case 'rejected':
		case 'banned':
			return [sql`${links.reviewedAt} desc nulls last`, desc(links.createdAt), asc(links.id)];
	}
}

export async function listLinks(state: LinkStatus, limit = LIST_LIMIT) {
	return db
		.select(listSelection)
		.from(links)
		.where(eq(links.status, state))
		.orderBy(...orderFor(state))
		.limit(limit);
}

export async function getLink(id: string) {
	const [row] = await db.select(detailSelection).from(links).where(eq(links.id, id)).limit(1);
	return row ?? null;
}

export interface LinkAdminCounts {
	total: number;
	byStatus: Record<LinkStatus, number>;
	derived: { backlinkLost: number; blocked: number; purgeSoon: number };
}

/** One round trip: status counts and the three derived queues (plan §2.5). */
export async function linkCounts(graceDays: number): Promise<LinkAdminCounts> {
	const [row] = await db
		.select({
			total: sql<number>`count(*)::int`,
			pending: sql<number>`(count(*) filter (where ${links.status} = 'pending'))::int`,
			approved: sql<number>`(count(*) filter (where ${links.status} = 'approved'))::int`,
			outdated: sql<number>`(count(*) filter (where ${links.status} = 'outdated'))::int`,
			rejected: sql<number>`(count(*) filter (where ${links.status} = 'rejected'))::int`,
			banned: sql<number>`(count(*) filter (where ${links.status} = 'banned'))::int`,
			backlinkLost: sql<number>`(count(*) filter (where ${links.status} in ('approved', 'outdated') and ${links.backlinkMissingStreak} >= 2))::int`,
			blocked: sql<number>`(count(*) filter (where ${links.lastErrorKind} = 'waf' and (${links.lastOkAt} is null or ${links.lastOkAt} < now() - interval '7 days')))::int`,
			purgeSoon: sql<number>`(count(*) filter (where ${links.status} = 'outdated' and ${links.lostSince} < now() - make_interval(days => ${Math.max(0, graceDays - 7)})))::int`
		})
		.from(links);

	const byStatus = Object.fromEntries(LINK_STATUSES.map((status) => [status, 0])) as Record<
		LinkStatus,
		number
	>;
	for (const status of LINK_STATUSES) byStatus[status] = row[status];

	return {
		total: row.total,
		byStatus,
		derived: {
			backlinkLost: row.backlinkLost,
			blocked: row.blocked,
			purgeSoon: row.purgeSoon
		}
	};
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface LinkCreateInput {
	name: string;
	url: string;
	backlinkUrl: string;
	avatar?: string | null;
	description?: string | null;
	email?: string | null;
	sortOrder?: number;
	checkEnabled?: boolean;
}

export interface LinkFieldInput {
	name?: string;
	url?: string;
	avatar?: string | null;
	description?: string | null;
	email?: string | null;
	backlinkUrl?: string | null;
	sortOrder?: number;
	checkEnabled?: boolean;
}

async function allowSubPath(): Promise<boolean> {
	const apply = await getOption('friends.apply');
	return apply.allowSubPath;
}

function requireUrl(
	input: string,
	options: { allowSubPath: boolean }
): { url: string; host: string } {
	const result = normalizeLinkUrl(input, options);
	if (result.ok) return { url: result.url, host: result.host };
	throw new LinkAdminError(result.reason === 'subpath' ? 'subpath' : 'bad-url');
}

/** Optional avatar: https only (an http image would be blocked as mixed content). */
function optionalImageUrl(value: string | null | undefined): string | null {
	const raw = (value ?? '').trim();
	if (!raw) return null;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== 'https:') throw new LinkAdminError('bad-url');
		return parsed.href;
	} catch (err) {
		if (err instanceof LinkAdminError) throw err;
		throw new LinkAdminError('bad-url');
	}
}

function optionalText(value: string | null | undefined): string | null {
	const raw = (value ?? '').trim();
	return raw ? raw : null;
}

/**
 * Translate the two unique indexes and the two write-relevant CHECKs:
 * - `links_name_uniq` / `links_url_uniq` → taken
 * - `links_backlink_required_check` (a live row lost its backlink_url) →
 *   `backlink-required`; any other CHECK is a bug and must surface.
 */
function mapWriteError(err: unknown): LinkAdminError | never {
	const code = (err as { code?: string }).code;
	const constraint = (err as { constraint?: string }).constraint ?? '';
	if (code === '23505') {
		if (constraint === 'links_name_uniq') return new LinkAdminError('name-taken');
		return new LinkAdminError('url-taken');
	}
	if (code === '23514' && constraint === 'links_backlink_required_check') {
		return new LinkAdminError('backlink-required');
	}
	throw err;
}

/** Manual add lands as `approved` (plan §5.3): no precheck, admin's call. */
export async function createLink(input: LinkCreateInput, actorId: string): Promise<{ id: string }> {
	const name = (input.name ?? '').trim();
	if (!name) throw new LinkAdminError('name-required');
	const site = requireUrl(input.url ?? '', { allowSubPath: await allowSubPath() });
	// The backlink page is a specific page (often `/links`), never root-only.
	const backlink = requireUrl(input.backlinkUrl ?? '', { allowSubPath: true });
	try {
		const [row] = await db
			.insert(links)
			.values({
				name,
				url: site.url,
				host: site.host,
				avatar: optionalImageUrl(input.avatar),
				description: optionalText(input.description),
				email: optionalText(input.email),
				backlinkUrl: backlink.url,
				status: 'approved',
				reviewedBy: actorId,
				reviewedAt: new Date(),
				sortOrder: clampSortOrder(input.sortOrder),
				checkEnabled: input.checkEnabled ?? true
			})
			.returning({ id: links.id });
		return row;
	} catch (err) {
		throw mapWriteError(err);
	}
}

export async function updateLink(id: string, input: LinkFieldInput): Promise<void> {
	const row = await requireLinkRow(id);
	const patch: Record<string, unknown> = {};

	if (input.name !== undefined) {
		const name = input.name.trim();
		if (!name) throw new LinkAdminError('name-required');
		patch.name = name;
	}
	if (input.url !== undefined) {
		const site = requireUrl(input.url, { allowSubPath: await allowSubPath() });
		patch.url = site.url;
		patch.host = site.host;
	}
	if (input.backlinkUrl !== undefined) {
		const raw = (input.backlinkUrl ?? '').trim();
		if (!raw) {
			// CHECK 5: only rejected/banned rows may carry no backlink.
			if (row.status !== 'rejected' && row.status !== 'banned') {
				throw new LinkAdminError('backlink-required');
			}
			patch.backlinkUrl = null;
		} else {
			patch.backlinkUrl = requireUrl(raw, { allowSubPath: true }).url;
		}
	}
	if (input.avatar !== undefined) patch.avatar = optionalImageUrl(input.avatar);
	if (input.description !== undefined) patch.description = optionalText(input.description);
	if (input.email !== undefined) patch.email = optionalText(input.email);
	if (input.sortOrder !== undefined) patch.sortOrder = clampSortOrder(input.sortOrder);
	if (input.checkEnabled !== undefined) patch.checkEnabled = input.checkEnabled;

	if (Object.keys(patch).length === 0) return;
	try {
		const updated = await db
			.update(links)
			.set(patch)
			.where(eq(links.id, id))
			.returning({ id: links.id });
		if (updated.length === 0) throw new LinkAdminError('missing');
	} catch (err) {
		throw mapWriteError(err);
	}
}

async function requireLinkRow(id: string) {
	const row = await getLink(id);
	if (!row) throw new LinkAdminError('missing');
	return row;
}

/** Apply a manual transition under a status CAS: a concurrent change is `stale`. */
async function applyManualPatch(
	id: string,
	from: LinkStatus,
	patch: ManualTransitionPatch,
	actorId: string
): Promise<void> {
	const updated = await db
		.update(links)
		.set({
			status: patch.status,
			reason: patch.reason,
			lostSince: patch.lostSince,
			checkEnabled: patch.checkEnabled,
			reviewedBy: actorId,
			reviewedAt: new Date()
		})
		.where(and(eq(links.id, id), eq(links.status, from)))
		.returning({ id: links.id });
	if (updated.length === 0) throw new LinkAdminError('stale');
}

async function runManualAction(
	id: string,
	action: ManualAction,
	input: ManualTransitionInput,
	actorId: string
): Promise<void> {
	const row = await requireLinkRow(id);
	const patch = planManualTransition(
		{ status: row.status as LinkStatus, backlinkOk: row.backlinkOk },
		action,
		input
	);
	await applyManualPatch(id, row.status as LinkStatus, patch, actorId);
}

export async function approveLink(id: string, input: ManualTransitionInput, actorId: string) {
	await runManualAction(id, 'approve', input, actorId);
}

export async function rejectLink(id: string, input: ManualTransitionInput, actorId: string) {
	await runManualAction(id, 'reject', input, actorId);
}

export async function banLink(id: string, input: ManualTransitionInput, actorId: string) {
	await runManualAction(id, 'ban', input, actorId);
}

export async function restoreLink(id: string, input: ManualTransitionInput, actorId: string) {
	await runManualAction(id, 'restore', input, actorId);
}

export async function removeLink(id: string): Promise<void> {
	const removed = await db.delete(links).where(eq(links.id, id)).returning({ id: links.id });
	if (removed.length === 0) throw new LinkAdminError('missing');
}

/**
 * Bulk cleanup for the outdated tab (2026-10-26 ruling): the predicate lives
 * server-side, so the client cannot widen it. Rows that recovered between
 * render and click simply do not match and are reported as not deleted.
 */
export async function purgeOutdated(): Promise<{ deleted: number }> {
	const removed = await db
		.delete(links)
		.where(eq(links.status, 'outdated'))
		.returning({ id: links.id });
	return { deleted: removed.length };
}

export interface CheckOneDeps {
	fetchDeps?: FetchUnitDeps;
	now?: () => Date;
	sleepMs?: (ms: number) => Promise<void>;
}

export interface CheckOneResult {
	previousStatus: LinkStatus;
	status: LinkStatus;
	reach: string;
	backlink: string;
	checkedAt: Date;
}

/**
 * G4: single-site check inside the request, bounded. `retryOnce: false` keeps
 * the worst case at one fetch unit per axis (the job keeps its 30 s retry);
 * the write reuses the checker's CAS so a concurrent run/edit is `stale`, not
 * lost. The cooldown is DB-backed (`last_checked_at`), so it survives
 * restarts and needs no in-memory map.
 */
export async function checkOneLink(id: string, deps: CheckOneDeps = {}): Promise<CheckOneResult> {
	const now = deps.now ?? (() => new Date());
	const row = await requireLinkRow(id);
	const status = row.status as LinkStatus;
	if (status === 'rejected' || status === 'banned') throw new LinkAdminError('not-checkable');
	if (
		row.lastCheckedAt &&
		now().getTime() - row.lastCheckedAt.getTime() < MANUAL_CHECK_COOLDOWN_MS
	) {
		throw new LinkAdminError('busy');
	}

	const [checks, policy] = await Promise.all([
		getOption('friends.checks'),
		getOption('friends.policy')
	]);
	const origin = publicOrigin();
	const userAgent = buildUserAgent(origin);
	const acceptedBacklinkHosts = deriveAcceptedHosts(origin, policy.acceptedBacklinkHosts);

	const outcome = await checkSite(
		{ url: row.url, host: row.host, backlinkUrl: row.backlinkUrl },
		{
			userAgent,
			timeoutMs: checks.timeoutMs,
			acceptedBacklinkHosts,
			retryOnce: false,
			now
		},
		{
			oracle: createRunRobotsOracle(userAgent, checks.timeoutMs, deps.fetchDeps),
			fetchDeps: deps.fetchDeps,
			sleepMs: deps.sleepMs
		}
	);

	const snapshot: LinkRowSnapshot = {
		id: row.id,
		url: row.url,
		host: row.host,
		status,
		lostSince: row.lostSince,
		backlinkUrl: row.backlinkUrl,
		failStreak: row.failStreak,
		backlinkMissingStreak: row.backlinkMissingStreak,
		lastOkAt: row.lastOkAt,
		backlinkOk: row.backlinkOk,
		backlinkCheckedAt: row.backlinkCheckedAt,
		lastErrorKind: row.lastErrorKind,
		lastCheckedAt: row.lastCheckedAt,
		updatedAt: row.updatedAt
	};
	const plan = deriveRowUpdate(snapshot, outcome, { failStreak: checks.failStreak }, now());

	const updated = await db
		.update(links)
		.set({
			lastCheckedAt: plan.lastCheckedAt,
			lastOkAt: plan.lastOkAt,
			status: plan.status,
			lostSince: plan.lostSince,
			failStreak: plan.failStreak,
			backlinkMissingStreak: plan.backlinkMissingStreak,
			backlinkOk: plan.backlinkOk,
			backlinkCheckedAt: plan.backlinkCheckedAt,
			lastErrorKind: plan.lastErrorKind,
			recentChecks: ringSqlFragment(outcome.entries),
			// Machine check must not look like a human edit (job discipline).
			updatedAt: row.updatedAt
		})
		.where(linkWritePredicate(snapshot, row.checkEnabled))
		.returning({ id: links.id });
	if (updated.length === 0) throw new LinkAdminError('stale');

	return {
		previousStatus: status,
		status: plan.status,
		reach: outcome.reach,
		backlink: outcome.backlink,
		checkedAt: plan.lastCheckedAt
	};
}

/**
 * G8: batch checks are the scheduler's job (`links.check`, manual runs
 * allowed). Enqueue dedupes on the queued/running unique index; a CLI run
 * holding the lock leaves the row queued for the next drain tick.
 */
export async function queueCheckAll(): Promise<{ id: string; deduplicated: boolean }> {
	const checks = await getOption('friends.checks');
	if (!checks.enabled) throw new LinkAdminError('checks-disabled');
	return enqueueJob(db, 'links.check', 'manual');
}

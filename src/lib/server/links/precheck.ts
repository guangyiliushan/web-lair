import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
	linkPrechecks,
	type LinkPrecheckRow,
	type LinkPrecheckTrigger
} from '../db/content/link-precheck.schema.ts';
import type { LinkCheck, LinkErrorKind } from '../../utils/link-meta.ts';
import { checkSite, type BacklinkAxis, type ReachAxis } from './check-site.ts';
import { buildUserAgent, type FetchUnitDeps } from './fetch.ts';
import { createRunRobotsOracle, deriveAcceptedHosts, publicOrigin } from './job.ts';
import { normalizeHost } from './normalize.ts';

/**
 * Application-stage precheck (links L4): one bounded run of the shared site
 * checker that only ever produces evidence. It never promotes, demotes or
 * re-times a row - status, streaks and `last_checked_at` belong to the job
 * (`deriveRowUpdate`) and to the admin's explicit "check now".
 *
 * Runs live in `link_prechecks` rather than the `links.recent_checks` ring:
 * the ring is a ten-entry checker window, so a badge or cooldown read from it
 * would lose data as soon as the job runs. The `running` row doubles as the
 * single-flight lock (partial unique index) and is reclaimed after
 * `PRECHECK_STALE_MS` so a crashed request cannot wedge a link.
 */

export const PRECHECK_TIMEOUT_MS = 5_000;
export const PRECHECK_BUDGET_MS = 15_000;
export const PRECHECK_COOLDOWN_MS = 30_000;
export const PRECHECK_STALE_MS = 60_000;

export interface PrecheckConfig {
	checks: { enabled: boolean; timeoutMs: number };
	policy: { acceptedBacklinkHosts: string[] };
}

export interface PrecheckDeps {
	fetchDeps?: FetchUnitDeps;
	now?: () => Date;
	sleepMs?: (ms: number) => Promise<void>;
	/** Test seam: shorten the whole-precheck budget. */
	precheckBudgetMs?: number;
}

export type PrecheckDb = Pick<
	PostgresJsDatabase<Record<string, never>>,
	'select' | 'insert' | 'update'
>;

export interface PrecheckOutcome {
	reach: ReachAxis;
	backlink: BacklinkAxis;
	/** Axis evidence for logs/debugging; never written to the parent row. */
	entries: LinkCheck[];
	ok: boolean;
	errorKind: LinkErrorKind | null;
	note: string | null;
	durationMs: number;
}

/** User-fixable conflicts; the admin route maps these to Paraglide keys. */
export class PrecheckError extends Error {
	constructor(readonly code: 'busy' | 'checks-disabled' | 'missing') {
		super(code);
		this.name = 'PrecheckError';
	}
}

/** Whole-precheck budget; null means the budget expired (evidence is partial). */
async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([promise, expiry]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function firstFailure(entries: LinkCheck[]): LinkCheck | undefined {
	return entries.find((entry) => !entry.ok);
}

/**
 * Network half: reachability + backlink through the shared checker with
 * `retryOnce: false` and the 5 s per-request floor. Pure - no database.
 */
export async function runPrecheck(
	link: { url: string; backlinkUrl: string },
	config: PrecheckConfig,
	deps: PrecheckDeps = {}
): Promise<PrecheckOutcome> {
	const started = Date.now();
	const now = deps.now ?? (() => new Date());

	if (!config.checks.enabled) {
		return {
			reach: 'skipped',
			backlink: 'skipped',
			entries: [],
			ok: false,
			errorKind: null,
			note: 'precheck: disabled',
			durationMs: Date.now() - started
		};
	}

	const origin = publicOrigin();
	const userAgent = buildUserAgent(origin);
	const timeoutMs = Math.min(config.checks.timeoutMs, PRECHECK_TIMEOUT_MS);
	const acceptedBacklinkHosts = deriveAcceptedHosts(origin, config.policy.acceptedBacklinkHosts);

	const outcome = await withBudget(
		checkSite(
			{ url: link.url, host: normalizeHost(link.url) ?? '', backlinkUrl: link.backlinkUrl },
			{ userAgent, timeoutMs, acceptedBacklinkHosts, retryOnce: false, now },
			{
				oracle: createRunRobotsOracle(userAgent, timeoutMs, deps.fetchDeps),
				fetchDeps: deps.fetchDeps,
				sleepMs: deps.sleepMs
			}
		),
		deps.precheckBudgetMs ?? PRECHECK_BUDGET_MS
	);

	if (!outcome) {
		return {
			reach: 'skipped',
			backlink: 'skipped',
			entries: [],
			ok: false,
			errorKind: 'timeout',
			note: 'precheck: incomplete',
			durationMs: Date.now() - started
		};
	}

	const failure = firstFailure(outcome.entries);
	if (outcome.entries.length === 0) {
		return {
			reach: outcome.reach,
			backlink: outcome.backlink,
			entries: [],
			ok: false,
			errorKind: null,
			note: 'precheck: no result',
			durationMs: Date.now() - started
		};
	}

	return {
		reach: outcome.reach,
		backlink: outcome.backlink,
		entries: outcome.entries,
		ok: outcome.reach === 'ok' && outcome.backlink === 'ok',
		errorKind: failure?.err ?? null,
		note: failure?.note ?? null,
		durationMs: Date.now() - started
	};
}

function isRunningConflict(err: unknown): boolean {
	const code = (err as { code?: string }).code;
	const constraint = (err as { constraint?: string }).constraint ?? '';
	return code === '23505' && constraint === 'link_prechecks_running_uniq';
}

/**
 * Persistence half: reclaim stale runs, enforce the cooldown, take the
 * single-flight slot, run, then close the run out. The parent row is never
 * written - a machine probe must not look like a human edit.
 */
export async function executePrecheck(input: {
	db: PrecheckDb;
	link: { id: string; url: string; backlinkUrl: string };
	trigger: LinkPrecheckTrigger;
	actorId?: string | null;
	config: PrecheckConfig;
	deps?: PrecheckDeps;
}): Promise<LinkPrecheckRow> {
	const deps = input.deps ?? {};
	const now = deps.now ?? (() => new Date());

	// A manual run must be loud about a disabled checker; the application
	// flow records the skipped run instead (see `runPrecheck`).
	if (input.trigger === 'admin' && !input.config.checks.enabled) {
		throw new PrecheckError('checks-disabled');
	}

	await input.db
		.update(linkPrechecks)
		.set({
			status: 'stale',
			finishedAt: now(),
			note: sql`coalesce(${linkPrechecks.note}, 'stale: reclaimed')`
		})
		.where(
			and(
				eq(linkPrechecks.linkId, input.link.id),
				eq(linkPrechecks.status, 'running'),
				lt(linkPrechecks.startedAt, sql`now() - make_interval(secs => ${PRECHECK_STALE_MS / 1000})`)
			)
		);

	const [lastCompleted] = await input.db
		.select({ finishedAt: linkPrechecks.finishedAt })
		.from(linkPrechecks)
		.where(and(eq(linkPrechecks.linkId, input.link.id), eq(linkPrechecks.status, 'completed')))
		.orderBy(desc(linkPrechecks.startedAt))
		.limit(1);
	if (
		lastCompleted?.finishedAt &&
		now().getTime() - lastCompleted.finishedAt.getTime() < PRECHECK_COOLDOWN_MS
	) {
		throw new PrecheckError('busy');
	}

	let run: LinkPrecheckRow;
	try {
		[run] = await input.db
			.insert(linkPrechecks)
			.values({
				linkId: input.link.id,
				trigger: input.trigger,
				status: 'running',
				actorId: input.actorId ?? null
			})
			.returning();
	} catch (err) {
		if (isRunningConflict(err)) throw new PrecheckError('busy');
		throw err;
	}

	let outcome: PrecheckOutcome;
	try {
		outcome = await runPrecheck(input.link, input.config, deps);
	} catch (err) {
		// The slot must not stay wedged if the checker throws unexpectedly.
		await input.db
			.update(linkPrechecks)
			.set({ status: 'stale', finishedAt: now(), note: 'precheck: aborted' })
			.where(eq(linkPrechecks.id, run.id));
		throw err;
	}

	const [completed] = await input.db
		.update(linkPrechecks)
		.set({
			status: 'completed',
			ok: outcome.ok,
			reach: outcome.reach,
			backlink: outcome.backlink,
			errorKind: outcome.errorKind,
			note: outcome.note,
			finishedAt: now(),
			durationMs: outcome.durationMs
		})
		.where(eq(linkPrechecks.id, run.id))
		.returning();

	// The link may have been deleted while the network check was running; the
	// FK cascade removed the running row, so there is no evidence to return.
	// A phantom "running" row must never reach the drawer.
	if (!completed) throw new PrecheckError('missing');
	return completed;
}

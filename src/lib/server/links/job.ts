import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { LinkCheck, LinkStatus } from '../../utils/link-meta.ts';
import { links } from '../db/content/link.schema.ts';
import {
	checkSite,
	type BacklinkAxis,
	type ReachAxis,
	type SiteCheckOutcome
} from './check-site.ts';
import {
	buildUserAgent,
	fetchUnit,
	LINK_CHECK_PRODUCT_TOKEN,
	LinkFetchError,
	type FetchUnitDeps
} from './fetch.ts';
import { createRobotsOracle, type RobotsOracle } from './robots.ts';
import { normalizeHost } from './normalize.ts';

/**
 * The links check job core (plan §4.5/§4.6; 2026-10-06 rulings): due
 * selection with the derived "self-healing" cadence (outdated runs at 3x the
 * cadence), an 8-minute soft budget per run with batched passes, global
 * concurrency from `friends.checks` with per-host serialisation, one
 * evidence-ring + streak UPDATE per site, and a structured log line per
 * site. Shared by the `links.check` builtin (drain) and
 * `scripts/jobs/check-links.ts` (manual / dry-run).
 *
 * The single-flight lock lives with the callers (`web_lair.job.links.check`,
 * same key the drain job lock derives); this module assumes it is held.
 */

/** Session advisory-lock key shared by drain, CLI and any manual trigger. */
export const LINK_LOCK_KEY = 'web_lair.job.links.check';

/** Plan §4.7 floor: parse at least 500 KiB of robots.txt (cap: 512 KiB). */
export const ROBOTS_BODY_BYTES = 512 * 1024;

/** Plan §4.5: batch 50 per pass, loop within the budget. */
export const DEFAULT_LIMIT_PER_PASS = 50;

/** Plan §4.5: soft budget per run - never race the 900 s cooperative timeout. */
export const DEFAULT_BUDGET_MS = 8 * 60 * 1000;

export type LinkRunDb = Pick<PostgresJsDatabase<Record<string, never>>, 'select' | 'update'>;

export interface LinkRunConfig {
	enabled: boolean;
	cadenceHours: number;
	failStreak: number;
	backlinkStreak: number;
	graceDays: number;
	timeoutMs: number;
	concurrency: number;
}

export interface LinkRunLogger {
	info(line: string): void;
	warn(line: string): void;
	error(line: string): void;
}

export interface LinkRunOptions {
	db: LinkRunDb;
	config: LinkRunConfig;
	/** Normalized accepted backlink hosts (empty = backlink axis disabled). */
	acceptedHosts: string[];
	origin: string | null;
	logger: LinkRunLogger;
	now?: () => Date;
	dryRun?: boolean;
	limitPerPass?: number;
	budgetMs?: number;
	sleepMs?: (ms: number) => Promise<void>;
	fetchDeps?: FetchUnitDeps;
}

export interface LinkRunLine {
	host: string;
	reach: ReachAxis;
	backlink: BacklinkAxis;
	detail: string;
}

export interface LinkRunSummary {
	disabled: boolean;
	dryRun: boolean;
	due: number;
	checked: number;
	ok: number;
	failed: number;
	skipped: number;
	inconclusive: number;
	writes: number;
	errors: number;
	budgetExhausted: boolean;
	backlinkSkippedReason: 'origin-missing' | null;
	lines: LinkRunLine[];
}

/** Row snapshot the derivation needs (selected in the due query). */
export interface LinkRowSnapshot {
	id: string;
	url: string;
	host: string;
	status: LinkStatus;
	lostSince: Date | null;
	backlinkUrl: string | null;
	failStreak: number;
	backlinkMissingStreak: number;
	lastOkAt: Date | null;
	backlinkOk: boolean | null;
	backlinkCheckedAt: Date | null;
	lastErrorKind: string | null;
}

export interface RowUpdatePlan {
	lastCheckedAt: Date;
	lastOkAt: Date | null;
	status: LinkStatus;
	lostSince: Date | null;
	failStreak: number;
	backlinkMissingStreak: number;
	backlinkOk: boolean | null;
	backlinkCheckedAt: Date | null;
	lastErrorKind: string | null;
}

/**
 * Plan §3 state-machine subset for L2 (pure, unit-tested): automatic
 * transitions only - `approved -> outdated` on the fail streak, recovery to
 * `approved` when reachable AND the backlink is present; `robots` and other
 * not-counted outcomes move nothing. Ban/prune stay manual/L4.
 */
export function deriveRowUpdate(
	row: LinkRowSnapshot,
	outcome: Pick<SiteCheckOutcome, 'entries' | 'reach' | 'backlink'>,
	config: Pick<LinkRunConfig, 'failStreak'>,
	now: Date
): RowUpdatePlan {
	const reachEntry = outcome.entries.find((entry) => entry.kind === 'reachability');
	const backlinkEntry = outcome.entries.find((entry) => entry.kind === 'backlink');

	let { failStreak, lastOkAt, status, lostSince } = {
		failStreak: row.failStreak,
		lastOkAt: row.lastOkAt,
		status: row.status,
		lostSince: row.lostSince
	};
	if (outcome.reach === 'ok') {
		failStreak = 0;
		lastOkAt = now;
		if (status === 'outdated' && outcome.backlink === 'ok') {
			status = 'approved';
			lostSince = null;
		}
	} else if (outcome.reach === 'fail') {
		failStreak = row.failStreak + 1;
		if (status === 'approved' && failStreak >= config.failStreak) {
			status = 'outdated';
			lostSince = now;
		}
	}

	let backlinkMissingStreak = row.backlinkMissingStreak;
	let backlinkOk = row.backlinkOk;
	let backlinkCheckedAt = row.backlinkCheckedAt;
	if (outcome.backlink === 'ok') {
		backlinkMissingStreak = 0;
		backlinkOk = true;
		backlinkCheckedAt = now;
	} else if (outcome.backlink === 'missing') {
		backlinkMissingStreak = row.backlinkMissingStreak + 1;
		backlinkOk = false;
		backlinkCheckedAt = now;
	}

	const lastErrorKind =
		reachEntry?.err ?? backlinkEntry?.err ?? (outcome.reach === 'ok' ? null : row.lastErrorKind);

	return {
		lastCheckedAt: now,
		lastOkAt,
		status,
		lostSince,
		failStreak,
		backlinkMissingStreak,
		backlinkOk,
		backlinkCheckedAt,
		lastErrorKind
	};
}

/** ORIGIN from the environment, canonicalized; null when unset/invalid. */
export function publicOrigin(): string | null {
	const raw = process.env.ORIGIN?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
	} catch {
		// fall through
	}
	return null;
}

/**
 * Accepted backlink hosts = ORIGIN's host (+ extra hosts; normalization
 * strips `www.`, so the www variant folds in automatically). Empty result =
 * the backlink axis is skipped for the whole run (plan §4.5 "ORIGIN 必配").
 */
export function deriveAcceptedHosts(origin: string | null, extra: string[]): string[] {
	const hosts = new Set<string>();
	const add = (value: string) => {
		const host = normalizeHost(value);
		if (host) hosts.add(host);
	};
	if (origin) add(origin);
	for (const value of extra) add(value);
	return [...hosts];
}

/** Wire the robots oracle to the pinned fetch unit (512 KiB, no robots gate). */
export function createRunRobotsOracle(
	userAgent: string,
	timeoutMs: number,
	fetchDeps?: FetchUnitDeps
): RobotsOracle {
	return createRobotsOracle({
		productToken: LINK_CHECK_PRODUCT_TOKEN,
		fetchRobots: async (robotsUrl) => {
			try {
				const result = await fetchUnit(
					robotsUrl,
					{ userAgent, timeoutMs, maxBytes: ROBOTS_BODY_BYTES, wantBody: true },
					fetchDeps
				);
				return { outcome: 'text', status: result.status, body: result.body ?? new Uint8Array() };
			} catch (err) {
				if (err instanceof LinkFetchError && err.code === 'redirect') {
					return { outcome: 'redirect-loop' };
				}
				return {
					outcome: 'network-error',
					message: err instanceof Error ? err.message : 'robots fetch failed'
				};
			}
		}
	});
}

export async function runLinkCheck(options: LinkRunOptions): Promise<LinkRunSummary> {
	const now = options.now ?? (() => new Date());
	const dryRun = options.dryRun === true;
	const limitPerPass = options.limitPerPass ?? DEFAULT_LIMIT_PER_PASS;
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const summary: LinkRunSummary = {
		disabled: false,
		dryRun,
		due: 0,
		checked: 0,
		ok: 0,
		failed: 0,
		skipped: 0,
		inconclusive: 0,
		writes: 0,
		errors: 0,
		budgetExhausted: false,
		backlinkSkippedReason: null,
		lines: []
	};

	if (!options.config.enabled) {
		summary.disabled = true;
		options.logger.warn(
			'[links] checks are disabled (friends.checks.enabled=false); nothing to do'
		);
		return summary;
	}

	const backlinkEnabled = options.acceptedHosts.length > 0;
	if (!backlinkEnabled) {
		summary.backlinkSkippedReason = 'origin-missing';
		options.logger.error(
			'[links] backlink axis disabled: ORIGIN is unset and acceptedBacklinkHosts is empty (see plan §4.5)'
		);
	}

	const userAgent = buildUserAgent(options.origin);
	const oracle = createRunRobotsOracle(userAgent, options.config.timeoutMs, options.fetchDeps);
	const deadline = Date.now() + budgetMs;

	const perPass = async (): Promise<number> => {
		const cadence = options.config.cadenceHours;
		const rows = await options.db
			.select({
				id: links.id,
				url: links.url,
				host: links.host,
				status: links.status,
				lostSince: links.lostSince,
				backlinkUrl: links.backlinkUrl,
				failStreak: links.failStreak,
				backlinkMissingStreak: links.backlinkMissingStreak,
				lastOkAt: links.lastOkAt,
				backlinkOk: links.backlinkOk,
				backlinkCheckedAt: links.backlinkCheckedAt,
				lastErrorKind: links.lastErrorKind
			})
			.from(links)
			.where(
				sql`${links.status} in ('approved', 'outdated')
					and ${links.checkEnabled} = true
					and (${links.lastCheckedAt} is null
						or ${links.lastCheckedAt} <= now() - make_interval(hours => case
							when ${links.status} = 'outdated' then ${cadence * 3}
							else ${cadence}
						end))`
			)
			.orderBy(sql`${links.lastCheckedAt} asc nulls first`)
			.limit(limitPerPass);
		if (rows.length === 0) return 0;
		summary.due += rows.length;

		const hostQueues = new Map<string, Promise<unknown>>();
		const runWithHost = (host: string, fn: () => Promise<void>): Promise<unknown> => {
			const previous = hostQueues.get(host) ?? Promise.resolve();
			const next = previous.then(fn, fn);
			hostQueues.set(
				host,
				next.catch(() => {})
			);
			return next;
		};

		const concurrency = Math.max(1, options.config.concurrency);
		let cursor = 0;
		const lane = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= rows.length) return;
				const row = rows[index] as LinkRowSnapshot;
				await runWithHost(row.host, () => processSite(row));
			}
		};
		await Promise.all(Array.from({ length: concurrency }, lane));
		return rows.length;
	};

	const processSite = async (row: LinkRowSnapshot): Promise<void> => {
		try {
			const outcome = await checkSite(
				{ url: row.url, host: row.host, backlinkUrl: row.backlinkUrl },
				{
					userAgent,
					timeoutMs: options.config.timeoutMs,
					backlinkEnabled,
					acceptedBacklinkHosts: options.acceptedHosts,
					now
				},
				{ oracle, fetchDeps: options.fetchDeps, sleepMs: options.sleepMs }
			);
			if (!dryRun) {
				await applyUpdate(row, outcome);
				summary.writes += 1;
			}
			const detail = outcome.entries.map((entry) => formatEntry(entry)).join(' ');
			const note = outcome.notes.length > 0 ? ` (${outcome.notes.join('; ')})` : '';
			options.logger.info(`[links] ${row.host} ${detail}${note}`);
			summary.lines.push({
				host: row.host,
				reach: outcome.reach,
				backlink: outcome.backlink,
				detail
			});
			summary.checked += 1;
			if (outcome.reach === 'ok') summary.ok += 1;
			else if (outcome.reach === 'fail') summary.failed += 1;
			else summary.skipped += 1;
			if (outcome.backlink === 'inconclusive') summary.inconclusive += 1;
		} catch (err) {
			summary.errors += 1;
			options.logger.error(
				`[links] ${row.host} internal error: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	};

	const applyUpdate = async (row: LinkRowSnapshot, outcome: SiteCheckOutcome): Promise<void> => {
		const plan = deriveRowUpdate(row, outcome, options.config, now());
		const ring = sql`(
			select jsonb_agg(e order by ord) from (
				select e, ord from (
					select e, ord from jsonb_array_elements(coalesce(${links.recentChecks}, '[]'::jsonb)) with ordinality as t(e, ord)
					union all
					select v, 100000 + i from jsonb_array_elements(${JSON.stringify(outcome.entries)}::jsonb) with ordinality as u(v, i)
				) merged
				order by ord desc
				limit 10
			) newest
		)`;
		await options.db
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
				recentChecks: ring
			})
			.where(eq(links.id, row.id));
	};

	let passes = 0;
	for (;;) {
		if (Date.now() >= deadline) {
			summary.budgetExhausted = true;
			break;
		}
		const processed = await perPass();
		if (processed === 0) break;
		passes += 1;
		if (processed < limitPerPass) break;
		if (dryRun) break; // nothing persisted: a second pass would re-read the same rows
	}
	if (passes === 0 && summary.due === 0) {
		options.logger.info('[links] no due sites');
	}
	return summary;
}

function formatEntry(entry: LinkCheck): string {
	const status = entry.ok ? 'ok' : (entry.err ?? 'fail');
	const http = entry.http !== undefined ? ` ${entry.http}` : '';
	const ms = entry.ms !== undefined ? ` ${entry.ms}ms` : '';
	const note = entry.note ? ` [${entry.note}]` : '';
	return `${entry.kind}:${status}${http}${ms}${note}`;
}

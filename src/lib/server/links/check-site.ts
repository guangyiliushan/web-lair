import type { LinkCheck, LinkErrorKind } from '../../utils/link-meta.ts';
import { classifyFetchFailure, classifyHttpStatus } from './classify.ts';
import { fetchUnit, LinkFetchError, type FetchUnitDeps, type FetchUnitResult } from './fetch.ts';
import { decodeHtmlBody, findBacklink } from './parse-backlink.ts';
import { isSameSite, normalizeHost, urlKey } from './normalize.ts';
import { RobotsDisallowedError, RobotsUnreachableError, type RobotsOracle } from './robots.ts';

/**
 * One-site check orchestration (plan §4.1/§4.8): reachability +/- backlink
 * axes, both in the same round; robots gated per request URL; in-run retry
 * (x1, 30 s gap) for timeout/5xx; the declared backlink page falls back to
 * the homepage when it fails hard; inconclusive scans never touch streaks.
 * All verdicts come back as ring entries + axis flags; the job maps them to
 * rows and counters.
 */

/** Plan §4.2 body cap for scanned pages. */
export const SCAN_BODY_BYTES = 256 * 1024;

export type ReachAxis = 'ok' | 'fail' | 'skipped';
export type BacklinkAxis = 'ok' | 'missing' | 'inconclusive' | 'skipped';

export interface SiteCheckRow {
	url: string;
	host: string;
	backlinkUrl: string | null;
}

export interface SiteCheckConfig {
	userAgent: string;
	timeoutMs: number;
	backlinkEnabled: boolean;
	/** Normalized accepted hosts for backlink detection. */
	acceptedBacklinkHosts: readonly string[];
	/** Retry timeout/5xx once in-run (plan §4.4). Default true. */
	retryOnce?: boolean;
	/**
	 * Budget gate for the in-run retry: consulted before the 30 s sleep; a
	 * false return skips the retry (review finding 2026-10-06 - the run
	 * budget must bound a single pass too, not just the pass boundary).
	 */
	retryAllowed?: () => boolean;
	now?: () => Date;
}

export interface SiteCheckOutcome {
	entries: LinkCheck[];
	reach: ReachAxis;
	backlink: BacklinkAxis;
	/** Free-form notes for the run log. */
	notes: string[];
}

export interface SiteCheckDeps {
	oracle: RobotsOracle;
	fetchDeps?: FetchUnitDeps;
	/** Sleep for the retry gap (plan §4.4: 30 s); injectable for tests. */
	sleepMs?: (ms: number) => Promise<void>;
}

const RETRY_GAP_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function checkSite(
	row: SiteCheckRow,
	config: SiteCheckConfig,
	deps: SiteCheckDeps
): Promise<SiteCheckOutcome> {
	const now = config.now ?? (() => new Date());
	const entries: LinkCheck[] = [];
	const notes: string[] = [];
	const baseOptions = { userAgent: config.userAgent, timeoutMs: config.timeoutMs };

	const beforeHop = async (url: URL) => {
		const decision = await deps.oracle.decisionFor(url);
		if (decision.kind === 'disallow') throw new RobotsDisallowedError(decision.reason);
		if (decision.kind === 'unreachable') throw new RobotsUnreachableError(decision.reason);
	};

	const fetchWithRetry = async (
		url: string,
		options: { wantBody: boolean }
	): Promise<FetchUnitResult> => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			let result: FetchUnitResult | null = null;
			let thrown: unknown = null;
			try {
				result = await fetchUnit(
					url,
					{ ...baseOptions, maxBytes: SCAN_BODY_BYTES, wantBody: options.wantBody, beforeHop },
					deps.fetchDeps
				);
			} catch (err) {
				thrown = err;
			}
			if (attempt === 0 && config.retryOnce !== false) {
				const retryable =
					thrown !== null
						? isRetryableFailure(thrown)
						: (classifyHttpStatus(result!.status).failure?.retryable ?? false);
				if (retryable && (config.retryAllowed ? config.retryAllowed() : true)) {
					await (deps.sleepMs ?? defaultSleep)(RETRY_GAP_MS);
					continue;
				}
			}
			if (result) return result;
			throw thrown;
		}
		throw new Error('unreachable');
	};

	/** Thrown-error -> axis + ring vocabulary (plan §4.3/§4.8). */
	const mapThrown = (err: unknown): { axis: ReachAxis; kind: LinkErrorKind; note: string } => {
		if (err instanceof RobotsDisallowedError || err instanceof RobotsUnreachableError) {
			return { axis: 'skipped', kind: 'robots', note: err.message };
		}
		if (err instanceof LinkFetchError) {
			if (err.code === 'redirect') return { axis: 'fail', kind: 'redirect', note: err.message };
			return { axis: 'skipped', kind: 'unsupported', note: err.message };
		}
		const failure = classifyFetchFailure(err);
		return {
			axis: failure.countsFailure ? 'fail' : 'skipped',
			kind: failure.kind,
			note: failure.detail ?? 'fetch failure'
		};
	};

	// --- reachability axis -------------------------------------------------
	let reach: ReachAxis;
	let homepageResult: FetchUnitResult | null = null;
	const sameTarget = row.backlinkUrl !== null && urlKey(row.backlinkUrl) === urlKey(row.url);
	const wantHomeBody = config.backlinkEnabled && sameTarget;
	{
		const started = Date.now();
		const at = now().toISOString();
		try {
			homepageResult = await fetchWithRetry(row.url, { wantBody: wantHomeBody });
			const cls = classifyHttpStatus(homepageResult.status);
			if (cls.ok) {
				reach = 'ok';
				const noteParts: string[] = [];
				try {
					const finalHost = normalizeHost(new URL(homepageResult.finalUrl).hostname);
					if (finalHost && !isSameSite(finalHost, row.host)) {
						noteParts.push(`offsite → ${homepageResult.finalUrl}`);
					}
				} catch {
					// Unparsable final URL: no offsite note.
				}
				entries.push({
					at,
					kind: 'reachability',
					ok: true,
					http: homepageResult.status,
					ms: Date.now() - started,
					...(noteParts.length ? { note: noteParts.join('; ') } : {})
				});
			} else {
				const failure = cls.failure!;
				reach = failure.countsFailure ? 'fail' : 'skipped';
				entries.push({
					at,
					kind: 'reachability',
					ok: false,
					http: homepageResult.status,
					err: failure.kind,
					ms: Date.now() - started,
					note: failure.detail
				});
			}
		} catch (err) {
			const mapped = mapThrown(err);
			reach = mapped.axis;
			entries.push({
				at,
				kind: 'reachability',
				ok: false,
				err: mapped.kind,
				ms: Date.now() - started,
				note: mapped.note
			});
		}
	}

	// --- backlink axis -----------------------------------------------------
	let backlink: BacklinkAxis = 'skipped';
	if (!config.backlinkEnabled) {
		notes.push('backlink axis disabled (origin-missing)');
	} else if (!row.backlinkUrl) {
		notes.push('no backlink_url');
	} else {
		const accepted = config.acceptedBacklinkHosts;

		const scan = (
			result: FetchUnitResult,
			startedAt: number
		): { axis: BacklinkAxis; entry: LinkCheck } => {
			const at = now().toISOString();
			const ms = Date.now() - startedAt;
			const cls = classifyHttpStatus(result.status);
			if (cls.ok) {
				const contentType = (result.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
				const htmlLike =
					contentType === '' ||
					contentType === 'text/html' ||
					contentType === 'application/xhtml+xml';
				if (!htmlLike) {
					return {
						axis: 'inconclusive',
						entry: {
							at,
							kind: 'backlink',
							ok: false,
							http: result.status,
							err: 'link_missing',
							ms,
							note: `non-html: ${contentType}`
						}
					};
				}
				const html = decodeHtmlBody(result.body ?? new Uint8Array(), result.contentType);
				const finding = findBacklink(html, result.finalUrl, accepted);
				if (finding.found) {
					return {
						axis: 'ok',
						entry: {
							at,
							kind: 'backlink',
							ok: true,
							http: result.status,
							ms,
							...(finding.notes.length ? { note: finding.notes.join('; ') } : {})
						}
					};
				}
				if (result.truncated) {
					return {
						axis: 'inconclusive',
						entry: {
							at,
							kind: 'backlink',
							ok: false,
							http: result.status,
							err: 'link_missing',
							ms,
							note: 'truncated'
						}
					};
				}
				return {
					axis: 'missing',
					entry: { at, kind: 'backlink', ok: false, http: result.status, err: 'link_missing', ms }
				};
			}
			const failure = cls.failure!;
			if (failure.countsFailure) {
				return {
					axis: 'missing',
					entry: {
						at,
						kind: 'backlink',
						ok: false,
						http: result.status,
						err: 'page_missing',
						ms,
						note: failure.detail
					}
				};
			}
			const notCounted =
				result.status === 429 && result.retryAfter
					? `not counted; retry-after ${result.retryAfter}`
					: 'not counted';
			return {
				axis: 'skipped',
				entry: {
					at,
					kind: 'backlink',
					ok: false,
					http: result.status,
					err: failure.kind,
					ms,
					note: notCounted
				}
			};
		};

		const started = Date.now();
		let outcome: { axis: BacklinkAxis; entry: LinkCheck } | null;
		if (sameTarget) {
			// One fetch serves both axes (plan §4.1); a failed homepage fetch
			// already told us everything a re-fetch would.
			outcome = homepageResult ? scan(homepageResult, started) : null;
			if (!outcome) notes.push('backlink skipped: homepage fetch failed');
		} else {
			const homepageFallback = async (): Promise<{
				axis: BacklinkAxis;
				entry: LinkCheck;
			} | null> => {
				if (sameTarget) return null;
				try {
					const homeResult =
						homepageResult && homepageResult.body !== null
							? homepageResult
							: await fetchWithRetry(row.url, { wantBody: true });
					const fallback = scan(homeResult, started);
					if (fallback.axis !== 'ok') return null;
					fallback.entry.note = [fallback.entry.note, 'fallback: homepage']
						.filter(Boolean)
						.join('; ');
					return fallback;
				} catch {
					return null;
				}
			};
			try {
				const result = await fetchWithRetry(row.backlinkUrl, { wantBody: true });
				outcome = scan(result, started);
				// A declared page that failed hard (404/410/5xx final) falls
				// back to the homepage for the link scan (plan §4.1
				// "申报页失败回退首页").
				if (outcome.axis === 'missing' && outcome.entry.err === 'page_missing') {
					outcome = (await homepageFallback()) ?? outcome;
				}
			} catch (err) {
				const mapped = mapThrown(err);
				if (mapped.axis === 'fail') {
					outcome =
						(await homepageFallback()) ??
						({
							axis: 'missing',
							entry: {
								at: now().toISOString(),
								kind: 'backlink',
								ok: false,
								err: 'page_missing',
								ms: Date.now() - started,
								note: mapped.note
							}
						} satisfies { axis: BacklinkAxis; entry: LinkCheck });
				} else {
					outcome = {
						axis: 'skipped',
						entry: {
							at: now().toISOString(),
							kind: 'backlink',
							ok: false,
							err: mapped.kind,
							ms: Date.now() - started,
							note: mapped.note
						}
					};
				}
			}
		}
		if (outcome) {
			entries.push(outcome.entry);
			backlink = outcome.axis;
		}
	}

	return { entries, reach, backlink, notes };
}

/** Timeout-class failures are retried in-run (plan §4.4); nothing else is. */
function isRetryableFailure(err: unknown): boolean {
	if (err instanceof LinkFetchError) return false;
	if (err instanceof RobotsDisallowedError || err instanceof RobotsUnreachableError) return false;
	return classifyFetchFailure(err).retryable;
}

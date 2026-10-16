import { getCache } from '$lib/server/cache';
import type { CacheStore } from '$lib/server/cache/store';
import { getOption } from '$lib/server/config/options-registry';

/**
 * Presence service (ledger §23; platform plan §B, realtime batch R1).
 *
 * Zero PG tables: the site online count, per-content reader count, position
 * histogram and admin dots, today's unique tabs and the daily peak all live
 * in the cache layer on four key families (README of the register, R-5):
 *
 *   presence:site          ZSET token -> last_seen (epoch seconds)
 *   presence:c:<id>        ZSET "<bucket>:<token>" -> last_seen
 *   presence:day:<date>    SET of tokens seen today
 *   presence:max:<date>    ZSET sentinel, member = score = observed count
 *
 * Window READS use ZCOUNT/ZRANGEBYSCORE with an exclusive cutoff and never raw
 * cardinality — a member whose score aged past the window must not count (the
 * ghost-count class the opening grill pinned with a live Valkey probe). Writes
 * are best-effort; reads degrade to `null` = "unavailable" (the UI renders
 * "—" / hides the badge). A dead cache must never break a page.
 *
 * Dates are bucketed in `site.timezone` (options registry), memoised
 * in-process for a minute so a heartbeat never pays a PG round trip.
 */

export const PRESENCE_WINDOW_SECONDS = 60;
export const PRESENCE_TTL_SECONDS = 48 * 60 * 60;
export const PRESENCE_BUCKETS = 20;

const SITE_KEY = 'presence:site';
const contentKey = (contentId: string) => `presence:c:${contentId}`;
const dayKey = (date: string) => `presence:day:${date}`;
const maxKey = (date: string) => `presence:max:${date}`;

const TIMEZONE_MEMO_MS = 60_000;
let timezoneMemo: { value: string; expiresAt: number } | null = null;

const ISO_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
};
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` for `timeMs` in `timeZone` (en-CA formats in ISO order). */
export function dateStamp(timeMs: number, timeZone: string): string {
	let formatter = dateFormatters.get(timeZone);
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat('en-CA', { timeZone, ...ISO_DATE_OPTIONS });
		} catch {
			// A hand-edited invalid zone must not break heartbeats or reads.
			formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...ISO_DATE_OPTIONS });
		}
		dateFormatters.set(timeZone, formatter);
	}
	return formatter.format(new Date(timeMs));
}

/** `site.timezone` as an option, memoised; falls back to UTC on any failure. */
async function resolveSiteTimezone(nowMs: number): Promise<string> {
	if (timezoneMemo && timezoneMemo.expiresAt > nowMs) return timezoneMemo.value;
	let timezone = 'UTC';
	try {
		const value = await getOption('site.timezone');
		if (typeof value === 'string' && value.trim() !== '') timezone = value;
	} catch {
		// fail-open: UTC keeps the feature working without the settings table
	}
	timezoneMemo = { value: timezone, expiresAt: nowMs + TIMEZONE_MEMO_MS };
	return timezone;
}

export interface PresenceDeps {
	/** Injected store (tests); defaults to the process-wide cache store. */
	store?: CacheStore;
	/** Clock in ms (tests); defaults to Date.now. */
	now?: () => number;
	/** Timezone override (tests); defaults to site.timezone (memoised). */
	timezone?: string;
}

export interface SitePresence {
	site: number;
	day: number;
	peak: number;
}

export interface ContentPresence {
	count: number;
	histogram: number[];
}

export interface PresenceHeartbeat {
	token: string;
	contentId?: string;
	bucket?: number;
}

function parseBucket(member: string): number | null {
	const separator = member.indexOf(':');
	if (separator <= 0) return null;
	const bucket = Number(member.slice(0, separator));
	return Number.isInteger(bucket) && bucket >= 0 && bucket < PRESENCE_BUCKETS ? bucket : null;
}

function isWritableBucket(bucket: number | undefined): bucket is number {
	return (
		bucket !== undefined && Number.isInteger(bucket) && bucket >= 0 && bucket < PRESENCE_BUCKETS
	);
}

/**
 * Record one heartbeat: refresh the site window, today's unique set and peak
 * sentinel, plus the content position bucket when supplied. Best-effort — a
 * read primitive may throw (store contract) and a dropped beat only means
 * this tab ages out of the window.
 */
export async function touchPresence(
	input: PresenceHeartbeat,
	deps: PresenceDeps = {}
): Promise<void> {
	const store = deps.store ?? getCache();
	const nowMs = deps.now?.() ?? Date.now();
	const nowSec = Math.floor(nowMs / 1000);
	const cutoff = nowSec - PRESENCE_WINDOW_SECONDS;
	const timezone = deps.timezone ?? (await resolveSiteTimezone(nowMs));
	const date = dateStamp(nowMs, timezone);
	try {
		await store.zadd(SITE_KEY, input.token, nowSec);
		await store.ztrim(SITE_KEY, cutoff);
		await store.expire(SITE_KEY, PRESENCE_TTL_SECONDS);
		await store.sadd(dayKey(date), input.token);
		await store.expire(dayKey(date), PRESENCE_TTL_SECONDS);
		const siteCount = await store.zcountAbove(SITE_KEY, cutoff);
		await store.zadd(maxKey(date), String(siteCount), siteCount);
		await store.expire(maxKey(date), PRESENCE_TTL_SECONDS);
		if (input.contentId !== undefined && isWritableBucket(input.bucket)) {
			const key = contentKey(input.contentId);
			await store.zadd(key, `${input.bucket}:${input.token}`, nowSec);
			await store.ztrim(key, cutoff);
			await store.expire(key, PRESENCE_TTL_SECONDS);
		}
	} catch {
		// fail-open: heartbeats are best-effort (store reads may throw)
	}
}

/** Site-wide numbers for the admin dashboard; `null` = cache unavailable. */
export async function readSitePresence(deps: PresenceDeps = {}): Promise<SitePresence | null> {
	const store = deps.store ?? getCache();
	const nowMs = deps.now?.() ?? Date.now();
	const timezone = deps.timezone ?? (await resolveSiteTimezone(nowMs));
	const date = dateStamp(nowMs, timezone);
	const cutoff = Math.floor(nowMs / 1000) - PRESENCE_WINDOW_SECONDS;
	try {
		const [site, day, peakMembers] = await Promise.all([
			store.zcountAbove(SITE_KEY, cutoff),
			store.scard(dayKey(date)),
			store.zrangeAbove(maxKey(date), -Infinity)
		]);
		let peak = 0;
		for (const { member } of peakMembers) {
			const value = Number(member);
			if (Number.isInteger(value) && value > peak) peak = value;
		}
		return { site, day, peak };
	} catch {
		return null;
	}
}

/** Per-content reader count + 5% position histogram; `null` = unavailable. */
export async function readContentPresence(
	contentId: string,
	deps: PresenceDeps = {}
): Promise<ContentPresence | null> {
	const store = deps.store ?? getCache();
	const cutoff = Math.floor((deps.now?.() ?? Date.now()) / 1000) - PRESENCE_WINDOW_SECONDS;
	try {
		const members = await store.zrangeAbove(contentKey(contentId), cutoff);
		const histogram = new Array<number>(PRESENCE_BUCKETS).fill(0);
		let count = 0;
		for (const { member } of members) {
			const bucket = parseBucket(member);
			if (bucket !== null) {
				histogram[bucket] += 1;
				count += 1;
			}
		}
		return { count, histogram };
	} catch {
		return null;
	}
}

/** Anonymous position dots (bucket per active member) for the admin view. */
export async function readContentDots(
	contentId: string,
	deps: PresenceDeps = {}
): Promise<number[] | null> {
	const store = deps.store ?? getCache();
	const cutoff = Math.floor((deps.now?.() ?? Date.now()) / 1000) - PRESENCE_WINDOW_SECONDS;
	try {
		const members = await store.zrangeAbove(contentKey(contentId), cutoff);
		const dots: number[] = [];
		for (const { member } of members) {
			const bucket = parseBucket(member);
			if (bucket !== null) dots.push(bucket);
		}
		return dots;
	} catch {
		return null;
	}
}

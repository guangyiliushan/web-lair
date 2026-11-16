import { env } from '$env/dynamic/private';

/**
 * Sentinel traffic analytics client (M6 / P6, plan §3.1).
 *
 * Contract (Sentinel 1.1.5, digest pinned in deploy/monitoring/
 * compose.sentinel.yaml): `GET /api/traffic/dashboard` with a Bearer token.
 * The service is internal-only and derived data is rebuildable, so every
 * failure mode here is **fail-open**: the caller gets `null` and the admin
 * renders "—" instead of turning a Sentinel outage into a 500.
 *
 * PV semantics (T6.4): Sentinel's `requests` counts every request, including
 * static assets and API calls. The admin labels a filtered number as
 * "page requests" and never calls it visits/views. {@link isPagePath} owns the
 * filter; {@link summarizePageTraffic} applies it to the top-paths rows.
 */

export const SENTINEL_TIMEOUT_MS = 2_000;
export const SENTINEL_CACHE_TTL_MS = 60_000;
/**
 * Sentinel caps `limit` at 1000. A personal site stays far below this, but
 * when a response returns exactly this many rows the page-request total is a
 * lower bound and the UI says so ({@link TrafficSnapshot.pathsTruncated}).
 */
const PATHS_LIMIT = 1_000;
const BREAKDOWN_LIMIT = 50;

export type TrafficRange = '24h' | '7d' | '30d';

const RANGE_MS: Record<TrafficRange, number> = {
	'24h': 24 * 60 * 60 * 1_000,
	'7d': 7 * 24 * 60 * 60 * 1_000,
	'30d': 30 * 24 * 60 * 60 * 1_000
};

export interface SentinelStatusBreakdown {
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
}

export interface SentinelLatency {
	p50: number;
	p95: number;
	p99: number;
}

export interface SentinelOverview {
	requests: number;
	bytes_in: number;
	bytes_out: number;
	status: SentinelStatusBreakdown;
	latency: SentinelLatency;
	unique_visitors: number;
}

export interface SentinelPath {
	path: string;
	app: string;
	requests: number;
	bytes_out: number;
	s4xx: number;
	s5xx: number;
	p50: number;
	p95: number;
}

export interface SentinelBreakdownEntry {
	value: string;
	requests: number;
	bytes_out: number;
}

export interface SentinelSeriesBucket {
	bucket: number;
	requests: number;
	bytes_in: number;
	bytes_out: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
	unique_visitors: number;
	p95: number;
}

/** The dimensions this app reads. Sentinel returns twelve; the rest are ignored. */
export interface SentinelBreakdowns {
	status: SentinelBreakdownEntry[];
	referer: SentinelBreakdownEntry[];
	browser: SentinelBreakdownEntry[];
	device: SentinelBreakdownEntry[];
}

export interface SentinelDashboard {
	overview: SentinelOverview;
	paths: SentinelPath[];
	series: SentinelSeriesBucket[];
	breakdowns: SentinelBreakdowns;
	attribution: string | null;
}

export interface TrafficSnapshot extends SentinelDashboard {
	range: TrafficRange;
	from: string;
	to: string;
	fetchedAt: number;
	/** True when the paths list hit Sentinel's limit or carries its long tail. */
	pathsTruncated: boolean;
}

export interface SentinelConfig {
	url: string;
	token: string;
}

export interface SentinelDeps {
	/** Injected transport (tests); defaults to the global fetch. */
	fetch?: typeof fetch;
	/** Injected clock (cache expiry, query window); defaults to Date.now. */
	now?: () => number;
	/** Injected config; `undefined` reads the environment, `null` disables. */
	config?: SentinelConfig | null;
	/** Test seam for the request deadline; production is 2 s. */
	timeoutMs?: number;
}

interface CacheEntry {
	at: number;
	value: TrafficSnapshot | null;
}

const cache = new Map<TrafficRange, CacheEntry>();
const inflight = new Map<TrafficRange, Promise<TrafficSnapshot | null>>();

/** Test seam: drops cached snapshots and in-flight reads. */
export function clearSentinelCache(): void {
	cache.clear();
	inflight.clear();
}

/**
 * Reads `SENTINEL_URL` / `SENTINEL_TOKEN`. Missing or malformed values mean
 * "analytics disabled" — not an error. The token is never logged.
 */
export function readSentinelConfig(
	envLike: Record<string, string | undefined> = env
): SentinelConfig | null {
	const url = envLike.SENTINEL_URL?.trim();
	const token = envLike.SENTINEL_TOKEN?.trim();
	if (!url || !token) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	} catch {
		return null;
	}
	return { url: url.replace(/\/+$/, ''), token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number {
	const parsed = finiteNumber(value);
	return parsed !== null && parsed >= 0 ? parsed : 0;
}

function parseOverview(raw: unknown): SentinelOverview | null {
	if (!isRecord(raw) || !isRecord(raw.status) || !isRecord(raw.latency)) return null;
	const requests = finiteNumber(raw.requests);
	const p50 = finiteNumber(raw.latency.p50);
	const p95 = finiteNumber(raw.latency.p95);
	const p99 = finiteNumber(raw.latency.p99);
	if (requests === null || requests < 0 || p50 === null || p95 === null || p99 === null) {
		return null;
	}
	return {
		requests,
		bytes_in: nonNegative(raw.bytes_in),
		bytes_out: nonNegative(raw.bytes_out),
		status: {
			s2xx: nonNegative(raw.status.s2xx),
			s3xx: nonNegative(raw.status.s3xx),
			s4xx: nonNegative(raw.status.s4xx),
			s5xx: nonNegative(raw.status.s5xx)
		},
		latency: { p50, p95, p99 },
		unique_visitors: nonNegative(raw.unique_visitors)
	};
}

function parsePath(raw: unknown): SentinelPath | null {
	if (!isRecord(raw)) return null;
	const path = typeof raw.path === 'string' ? raw.path : null;
	const requests = finiteNumber(raw.requests);
	if (path === null || requests === null || requests < 0) return null;
	return {
		path,
		app: typeof raw.app === 'string' ? raw.app : '',
		requests,
		bytes_out: nonNegative(raw.bytes_out),
		s4xx: nonNegative(raw.s4xx),
		s5xx: nonNegative(raw.s5xx),
		p50: nonNegative(raw.p50),
		p95: nonNegative(raw.p95)
	};
}

function parseBreakdown(raw: unknown): SentinelBreakdownEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: SentinelBreakdownEntry[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.value !== 'string') continue;
		const requests = finiteNumber(item.requests);
		if (requests === null) continue;
		const entry: SentinelBreakdownEntry = {
			value: item.value,
			requests,
			bytes_out: nonNegative(item.bytes_out)
		};
		entries.push(entry);
	}
	return entries;
}

function parseSeriesBucket(raw: unknown): SentinelSeriesBucket | null {
	if (!isRecord(raw)) return null;
	const bucket = finiteNumber(raw.bucket);
	const requests = finiteNumber(raw.requests);
	if (bucket === null || requests === null || requests < 0) return null;
	return {
		bucket,
		requests,
		bytes_in: nonNegative(raw.bytes_in),
		bytes_out: nonNegative(raw.bytes_out),
		s2xx: nonNegative(raw.s2xx),
		s3xx: nonNegative(raw.s3xx),
		s4xx: nonNegative(raw.s4xx),
		s5xx: nonNegative(raw.s5xx),
		unique_visitors: nonNegative(raw.unique_visitors),
		p95: nonNegative(raw.p95)
	};
}

/**
 * Structural parse of the dashboard payload. It is deliberately forgiving on
 * additive fields and strict on the ones the page needs: an overview or paths
 * entry without numbers is a contract break, not a zero.
 */
export function parseTrafficDashboard(payload: unknown): SentinelDashboard | null {
	if (!isRecord(payload)) return null;
	const overview = parseOverview(payload.overview);
	if (!overview) return null;
	if (!Array.isArray(payload.paths) || !Array.isArray(payload.series)) return null;
	const rawBreakdowns = payload.breakdowns;
	if (!isRecord(rawBreakdowns) || !Array.isArray(rawBreakdowns.status)) return null;

	const paths = payload.paths.map(parsePath).filter((row): row is SentinelPath => row !== null);
	const series = payload.series
		.map(parseSeriesBucket)
		.filter((row): row is SentinelSeriesBucket => row !== null);
	return {
		overview,
		paths,
		series,
		breakdowns: {
			status: parseBreakdown(rawBreakdowns.status),
			referer: parseBreakdown(rawBreakdowns.referer),
			browser: parseBreakdown(rawBreakdowns.browser),
			device: parseBreakdown(rawBreakdowns.device)
		},
		attribution: typeof payload.attribution === 'string' ? payload.attribution : null
	};
}

function errorReason(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return 'unknown error';
}

/**
 * Sentinel 1.1.5's bound parser accepts exactly `YYYY-MM-DDTHH:MM:SSZ` — a
 * JS `toISOString()` with milliseconds is a 400 (verified against the pinned
 * image). Truncate to whole seconds; the 1m buckets make sub-second precision
 * meaningless anyway.
 */
function sentinelTimestamp(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchDashboard(
	range: TrafficRange,
	config: SentinelConfig,
	deps: SentinelDeps
): Promise<TrafficSnapshot> {
	const now = deps.now?.() ?? Date.now();
	const from = sentinelTimestamp(now - RANGE_MS[range]);
	const to = sentinelTimestamp(now);
	const params = new URLSearchParams({
		from,
		to,
		range,
		paths_limit: String(PATHS_LIMIT),
		breakdown_limit: String(BREAKDOWN_LIMIT)
	});
	const url = `${config.url}/api/traffic/dashboard?${params.toString()}`;
	const doFetch = deps.fetch ?? fetch;
	const response = await doFetch(url, {
		headers: {
			authorization: `Bearer ${config.token}`,
			accept: 'application/json'
		},
		signal: AbortSignal.timeout(deps.timeoutMs ?? SENTINEL_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(`Sentinel answered HTTP ${response.status}`);

	const payload: unknown = await response.json();
	const dashboard = parseTrafficDashboard(payload);
	if (!dashboard) throw new Error('Sentinel dashboard payload failed shape validation');

	return {
		...dashboard,
		range,
		from,
		to,
		fetchedAt: now,
		pathsTruncated: dashboard.paths.length >= PATHS_LIMIT
	};
}

/**
 * Cached, fail-open read of one range. Concurrent callers share one in-flight
 * request; successes and failures are both cached for 60 s, so a dead Sentinel
 * costs at most one 2 s timeout per range per minute.
 */
export async function readTrafficSnapshot(
	options: { range?: TrafficRange; deps?: SentinelDeps } = {}
): Promise<TrafficSnapshot | null> {
	const range = options.range ?? '24h';
	const deps = options.deps ?? {};
	const now = deps.now?.() ?? Date.now();
	const cached = cache.get(range);
	if (cached && now - cached.at < SENTINEL_CACHE_TTL_MS) return cached.value;

	const pending = inflight.get(range);
	if (pending) return pending;

	const request = (async (): Promise<TrafficSnapshot | null> => {
		try {
			const config = deps.config === undefined ? readSentinelConfig() : deps.config;
			if (!config) return null;
			const snapshot = await fetchDashboard(range, config, { ...deps, now: () => now });
			cache.set(range, { at: now, value: snapshot });
			return snapshot;
		} catch (error) {
			cache.set(range, { at: now, value: null });
			console.warn(
				`[analytics] Sentinel unavailable (${range}); rendering "—": ${errorReason(error)}`
			);
			return null;
		}
	})();

	inflight.set(range, request);
	// Cleanup runs in a microtask, after the synchronous `inflight.set` above —
	// including the config-null path, where the async body returns before its
	// first await. Deleting inside the body's `finally` would run before the set
	// and leave a settled promise pinned in the map forever.
	void request.then(
		() => {
			if (inflight.get(range) === request) inflight.delete(range);
		},
		() => {
			if (inflight.get(range) === request) inflight.delete(range);
		}
	);
	return request;
}

const NON_PAGE_PREFIXES = ['/_app', '/i', '/api'] as const;
const STATIC_EXTENSION =
	/\.(?:js|mjs|css|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|webmanifest|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|gz|br|wasm)$/i;

function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True when a request path is a page view for this site's PV metric:
 *   - no query/fragment (Sentinel already strips them; defensive here);
 *   - not under `/_app/`, `/i/` (served media) or `/api/`;
 *   - no static-file extension.
 * Admin pages count: they are real pages, and the dashboard is private anyway.
 */
export function isPagePath(rawPath: string): boolean {
	const path = rawPath.split('?')[0].split('#')[0];
	if (!path.startsWith('/')) return false;
	if (NON_PAGE_PREFIXES.some((prefix) => underPrefix(path, prefix))) return false;
	return !STATIC_EXTENSION.test(path);
}

export interface PageTrafficSummary {
	/** Sum of page requests across the filtered paths (lower bound when truncated). */
	pageRequests: number;
	topPages: SentinelPath[];
	/** Page paths with a 4xx count, ranked by that count (T6.4 "Top 404"). */
	topErrorPaths: SentinelPath[];
	/** Exact 404 total from Sentinel's status breakdown (all requests). */
	notFoundRequests: number;
	pathsTruncated: boolean;
}

export function summarizePageTraffic(snapshot: TrafficSnapshot): PageTrafficSummary {
	const pagePaths = snapshot.paths.filter((row) => isPagePath(row.path));
	const sorted = [...pagePaths].sort(
		(a, b) => b.requests - a.requests || a.path.localeCompare(b.path)
	);
	const errors = pagePaths
		.filter((row) => row.s4xx > 0)
		.sort((a, b) => b.s4xx - a.s4xx || b.requests - a.requests || a.path.localeCompare(b.path));
	// Sentinel folds every path outside TRAFFIC_TOPN into "__other__". It is a
	// mix of page/static/API requests, so it cannot be added to the page total,
	// but its presence means the sum above is a lower bound and the UI must say
	// so (review finding: the 1,000-row check alone cannot see this row).
	const hasLongTail = snapshot.paths.some((row) => row.path === '__other__');
	return {
		pageRequests: pagePaths.reduce((sum, row) => sum + row.requests, 0),
		topPages: sorted.slice(0, 10),
		topErrorPaths: errors.slice(0, 10),
		notFoundRequests:
			snapshot.breakdowns.status.find((entry) => entry.value === '404')?.requests ?? 0,
		pathsTruncated: snapshot.pathsTruncated || hasLongTail
	};
}

/** Ordered 24h/7d/30d series for a compact bar strip. */
export function seriesPoints(snapshot: TrafficSnapshot): SentinelSeriesBucket[] {
	return [...snapshot.series].sort((a, b) => a.bucket - b.bucket);
}

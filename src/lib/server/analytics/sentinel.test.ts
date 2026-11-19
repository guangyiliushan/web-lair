import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import {
	clearSentinelCache,
	isPagePath,
	parseTrafficDashboard,
	readSentinelConfig,
	readTrafficSnapshot,
	SENTINEL_CACHE_TTL_MS,
	SENTINEL_TIMEOUT_MS,
	seriesPoints,
	summarizePageTraffic,
	type SentinelConfig,
	type SentinelDeps
} from './sentinel';

const FIXTURE = JSON.parse(
	readFileSync(new URL('./fixtures/traffic-dashboard.json', import.meta.url), 'utf8')
) as unknown;

const CONFIG: SentinelConfig = { url: 'http://sentinel:8888', token: 'test-token' };

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function depsWith(
	fetchImpl: SentinelDeps['fetch'],
	extra: Omit<SentinelDeps, 'fetch' | 'config'> = {}
): SentinelDeps {
	return { config: CONFIG, fetch: fetchImpl, ...extra };
}

beforeEach(() => {
	clearSentinelCache();
	vi.restoreAllMocks();
});

describe('production constants', () => {
	it('locks the 2 s deadline and the 60 s cache', () => {
		expect(SENTINEL_TIMEOUT_MS).toBe(2_000);
		expect(SENTINEL_CACHE_TTL_MS).toBe(60_000);
	});
});

describe('parseTrafficDashboard (Sentinel API contract shape)', () => {
	it('accepts the recorded 1.1.5 dashboard response', () => {
		const dashboard = parseTrafficDashboard(FIXTURE);
		expect(dashboard).not.toBeNull();
		expect(dashboard?.overview.requests).toBe(11);
		expect(dashboard?.overview.status).toEqual({ s2xx: 9, s3xx: 0, s4xx: 2, s5xx: 0 });
		expect(dashboard?.overview.unique_visitors).toBe(8);
		expect(dashboard?.paths).toHaveLength(10);
		expect(dashboard?.breakdowns.status).toContainEqual({
			value: '404',
			requests: 2,
			bytes_out: 1600
		});
		expect(dashboard?.series).toHaveLength(24);
		expect(dashboard?.attribution).toBeNull();
	});

	it('contract: every path row carries the fields the page reads', () => {
		const dashboard = parseTrafficDashboard(FIXTURE);
		expect(dashboard).not.toBeNull();
		for (const row of dashboard!.paths) {
			expect(typeof row.path).toBe('string');
			expect(typeof row.app).toBe('string');
			for (const key of ['requests', 'bytes_out', 's4xx', 's5xx', 'p50', 'p95'] as const) {
				expect(Number.isFinite(row[key])).toBe(true);
			}
		}
		const bucket = dashboard!.series[0]!;
		for (const key of [
			'bucket',
			'requests',
			'bytes_in',
			'bytes_out',
			's2xx',
			's3xx',
			's4xx',
			's5xx',
			'unique_visitors',
			'p95'
		] as const) {
			expect(Number.isFinite(bucket[key])).toBe(true);
		}
	});

	it('rejects a payload without a numeric overview (fail-open upstream)', () => {
		expect(parseTrafficDashboard({ paths: [] })).toBeNull();
		expect(parseTrafficDashboard({ overview: { requests: 'nope' } })).toBeNull();
		expect(parseTrafficDashboard(null)).toBeNull();
	});

	it('rejects a payload that omits a required collection or latency member', () => {
		const base = {
			overview: {
				requests: 1,
				bytes_in: 0,
				bytes_out: 0,
				status: { s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0 },
				latency: { p50: 0, p95: 0, p99: 0 },
				unique_visitors: 1
			},
			paths: [],
			breakdowns: { status: [] },
			series: []
		};
		expect(parseTrafficDashboard(base)).not.toBeNull();
		expect(parseTrafficDashboard({ ...base, paths: undefined })).toBeNull();
		expect(parseTrafficDashboard({ ...base, series: undefined })).toBeNull();
		expect(parseTrafficDashboard({ ...base, breakdowns: undefined })).toBeNull();
		expect(
			parseTrafficDashboard({
				...base,
				overview: { ...base.overview, latency: { p50: 0, p95: 0 } }
			})
		).toBeNull();
	});

	it('drops malformed path rows instead of inventing zeros', () => {
		const dashboard = parseTrafficDashboard({
			overview: {
				requests: 1,
				bytes_in: 0,
				bytes_out: 0,
				status: { s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0 },
				latency: { p50: 0, p95: 0, p99: 0 },
				unique_visitors: 1
			},
			paths: [{ path: '/ok', requests: 1 }, { path: '/bad' }, { path: '/neg', requests: -1 }, null],
			breakdowns: { status: [] },
			series: []
		});
		expect(dashboard?.paths.map((row) => row.path)).toEqual(['/ok']);
	});
});

describe('readSentinelConfig', () => {
	it('requires both URL and token, and rejects non-http(s) URLs', () => {
		expect(readSentinelConfig({})).toBeNull();
		expect(readSentinelConfig({ SENTINEL_URL: 'http://sentinel:8888' })).toBeNull();
		expect(readSentinelConfig({ SENTINEL_URL: 'ftp://sentinel', SENTINEL_TOKEN: 't' })).toBeNull();
		expect(
			readSentinelConfig({ SENTINEL_URL: 'http://sentinel:8888/', SENTINEL_TOKEN: ' t ' })
		).toEqual({ url: 'http://sentinel:8888', token: 't' });
	});
});

describe('readTrafficSnapshot', () => {
	it('sends the Bearer token, the range window and all page limits', async () => {
		const fetchStub = vi.fn(async () => response(FIXTURE));
		const snapshot = await readTrafficSnapshot({
			range: '7d',
			deps: depsWith(fetchStub as unknown as SentinelDeps['fetch'], {
				now: () => 1_700_000_000_000
			})
		});
		expect(snapshot).not.toBeNull();
		expect(snapshot?.range).toBe('7d');
		expect(snapshot?.from).toBe('2023-11-07T22:13:20Z');
		expect(snapshot?.to).toBe('2023-11-14T22:13:20Z');
		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain('http://sentinel:8888/api/traffic/dashboard?');
		expect(url).toContain('range=7d');
		expect(url).toContain('from=2023-11-07T22%3A13%3A20Z');
		expect(url).toContain('to=2023-11-14T22%3A13%3A20Z');
		expect(url).not.toContain('.000Z');
		expect(url).toContain('paths_limit=1000');
		expect(url).toContain('breakdown_limit=50');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('caches a snapshot for 60 s and refetches after it expires', async () => {
		let now = 1_000_000;
		const fetchStub = vi.fn(async () => response(FIXTURE));
		const deps = depsWith(fetchStub as unknown as SentinelDeps['fetch'], { now: () => now });

		expect(await readTrafficSnapshot({ deps })).not.toBeNull();
		now += 59_999;
		expect(await readTrafficSnapshot({ deps })).not.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(1);

		now += 1;
		expect(await readTrafficSnapshot({ deps })).not.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	it('shares one in-flight request between concurrent readers', async () => {
		let resolveFetch: ((value: Response) => void) | null = null;
		const fetchStub = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				})
		);
		const deps = depsWith(fetchStub as unknown as SentinelDeps['fetch'], { now: () => 1_000 });
		const first = readTrafficSnapshot({ deps });
		const second = readTrafficSnapshot({ deps });
		await vi.waitFor(() => expect(resolveFetch).not.toBeNull());
		resolveFetch!(response(FIXTURE));
		expect(await first).not.toBeNull();
		expect(await second).not.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	it('fails open on HTTP errors and caches the failure for 60 s', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let now = 5_000;
		const fetchStub = vi.fn(async () => response({ error: 'down' }, 503));
		const deps = depsWith(fetchStub as unknown as SentinelDeps['fetch'], { now: () => now });

		await expect(readTrafficSnapshot({ deps })).resolves.toBeNull();
		await expect(readTrafficSnapshot({ deps })).resolves.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Sentinel unavailable'));
		expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('test-token'));

		now += 60_000;
		await expect(readTrafficSnapshot({ deps })).resolves.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});

	it('fails open when the request exceeds its deadline', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const slowFetch = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
				})
		);
		const started = Date.now();
		const result = await readTrafficSnapshot({
			deps: depsWith(slowFetch as unknown as SentinelDeps['fetch'], { timeoutMs: 20 })
		});
		expect(result).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('TimeoutError'));
	});

	it('fails open on a contract-breaking payload', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchStub = vi.fn(async () => response({ overview: null }));
		await expect(
			readTrafficSnapshot({ deps: depsWith(fetchStub as unknown as SentinelDeps['fetch']) })
		).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('shape validation'));
	});

	it('is disabled without config and does not call fetch', async () => {
		const fetchStub = vi.fn();
		const result = await readTrafficSnapshot({
			deps: { config: null, fetch: fetchStub as unknown as SentinelDeps['fetch'] }
		});
		expect(result).toBeNull();
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it('does not pin the settled config-null promise in the in-flight map', async () => {
		// The async body returns before its first await on this path; cleanup must
		// still run after the synchronous inflight.set.
		await readTrafficSnapshot({
			deps: { config: null, fetch: vi.fn() as unknown as SentinelDeps['fetch'] }
		});
		const fetchStub = vi.fn(async () => response(FIXTURE));
		const snapshot = await readTrafficSnapshot({
			deps: depsWith(fetchStub as unknown as SentinelDeps['fetch'])
		});
		expect(snapshot).not.toBeNull();
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});
});

describe('PV semantics (T6.4)', () => {
	it.each([
		['/', true],
		['/posts/hello', true],
		['/zh-cn/posts', true],
		['/about?utm=1', true],
		['/admin', true],
		['/_app/immutable/chunk.js', false],
		['/_app', false],
		['/i/photo.webp', false],
		['/i', false],
		['/api/health', false],
		['/api', false],
		['/style.css', false],
		['/feed.xml', false],
		['/sitemap.xml', false],
		['/manifest.webmanifest', false],
		['/posts/cover.PNG', false],
		['posts/no-slash', false]
	])('isPagePath(%s) = %s', (path, expected) => {
		expect(isPagePath(path)).toBe(expected);
	});

	it('sums only page paths and exposes exact 404s from the status breakdown', async () => {
		const snapshot = await readTrafficSnapshot({
			deps: depsWith(vi.fn(async () => response(FIXTURE)) as unknown as SentinelDeps['fetch'])
		});
		const summary = summarizePageTraffic(snapshot!);

		// 11 requests total: drop /_app/ (1), /i/ (1), /api/ (1), feed.xml (1),
		// style.css (1) -> 6 page requests across five paths.
		expect(summary.pageRequests).toBe(6);
		expect(summary.topPages).toHaveLength(5);
		expect(summary.topPages.map((row) => row.path)).toEqual([
			'/posts/missing-page',
			'/about',
			'/posts/hello',
			'/volume-append',
			'/zh-cn/posts'
		]);
		expect(summary.topErrorPaths.map((row) => [row.path, row.s4xx])).toEqual([
			['/posts/missing-page', 2]
		]);
		expect(summary.notFoundRequests).toBe(2);
		expect(summary.pathsTruncated).toBe(false);
	});

	it('orders the series by bucket and keeps the summary shape serialisable', async () => {
		const snapshot = await readTrafficSnapshot({
			deps: depsWith(vi.fn(async () => response(FIXTURE)) as unknown as SentinelDeps['fetch'])
		});
		const points = seriesPoints(snapshot!);
		expect(points).toHaveLength(24);
		expect(points[0]!.bucket).toBeLessThan(points[23]!.bucket);
		expect(JSON.parse(JSON.stringify(summarizePageTraffic(snapshot!)))).toMatchObject({
			pageRequests: 6,
			notFoundRequests: 2
		});
	});

	it('keeps exact 404s independent of per-path 4xx counts', async () => {
		const base = await readTrafficSnapshot({
			deps: depsWith(vi.fn(async () => response(FIXTURE)) as unknown as SentinelDeps['fetch'])
		});
		const summary = summarizePageTraffic({
			...base!,
			paths: [
				...base!.paths,
				{
					path: '/forbidden',
					app: 'lair.example',
					requests: 1,
					bytes_out: 10,
					s4xx: 1,
					s5xx: 0,
					p50: 2,
					p95: 3
				}
			]
		});
		// The status breakdown says 2 x 404; /posts/missing-page has 2 x 4xx and
		// /forbidden adds one 403. Summing s4xx would wrongly report 3.
		expect(summary.notFoundRequests).toBe(2);
		expect(summary.topErrorPaths.map((row) => [row.path, row.s4xx])).toEqual([
			['/posts/missing-page', 2],
			['/forbidden', 1]
		]);
	});

	it('marks the 1,000-row path cap as truncated', async () => {
		const payload = {
			...(FIXTURE as Record<string, unknown>),
			paths: Array.from({ length: 1000 }, (_, index) => ({
				path: `/p/${index}`,
				app: 'lair.example',
				requests: 1,
				bytes_out: 1,
				s4xx: 0,
				s5xx: 0,
				p50: 1,
				p95: 1
			}))
		};
		const snapshot = await readTrafficSnapshot({
			deps: depsWith(vi.fn(async () => response(payload)) as unknown as SentinelDeps['fetch'])
		});
		expect(snapshot?.paths).toHaveLength(1000);
		expect(snapshot?.pathsTruncated).toBe(true);
	});

	it('marks the page total as a lower bound when Sentinel folds paths into __other__', async () => {
		const base = await readTrafficSnapshot({
			deps: depsWith(vi.fn(async () => response(FIXTURE)) as unknown as SentinelDeps['fetch'])
		});
		const summary = summarizePageTraffic({
			...base!,
			paths: [
				...base!.paths,
				{
					path: '__other__',
					app: 'lair.example',
					requests: 7,
					bytes_out: 100,
					s4xx: 3,
					s5xx: 0,
					p50: 2,
					p95: 3
				}
			]
		});
		// __other__ mixes page/static/API requests, so it must not inflate the
		// page total; it only proves the total is a lower bound.
		expect(summary.pageRequests).toBe(6);
		expect(summary.pathsTruncated).toBe(true);
	});
});

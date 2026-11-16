import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route imports the Sentinel client, which reads $env; no config means
// the traffic card fails open to nulls in these unit tests.
vi.mock('$env/dynamic/private', () => ({ env: {} }));

/**
 * Route-level tests for the admin dashboard load (realtime R4 + dashboard
 * data statistics, 2026-10-21): the guard runs first, the quick-action
 * counters and the statistics block read real rows, and the realtime cards
 * carry the presence SSR initial values - read only while presence is
 * enabled, `null` (the "—" fallback) when it is off or when the cache read
 * degrades.
 *
 * The load uses three db reads (one aggregate execute + posts + notes) and
 * one session read; the queue below keeps that order explicit.
 */
const { dbMock, state, service, presenceService, analyticsService } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		globalRow: {} as Record<string, number | Array<Record<string, unknown>>>,
		postRow: {} as Record<string, number>,
		noteRow: {} as Record<string, number>,
		sessions: [] as Array<{ id: string; createdAt: Date; ipAddress: string | null }>,
		presenceEnabled: true,
		enabledThrows: false
	},
	service: { requireAdminRole: vi.fn() },
	presenceService: { readSitePresence: vi.fn() },
	analyticsService: { readTrafficSnapshot: vi.fn() }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/server/services/presence', () => ({
	readSitePresence: presenceService.readSitePresence
}));
vi.mock('$lib/server/analytics/sentinel', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/analytics/sentinel')>();
	return { ...actual, readTrafficSnapshot: analyticsService.readTrafficSnapshot };
});
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (key === 'site.timezone') return 'UTC';
		if (key === 'presence.enabled') {
			if (state.enabledThrows) throw new Error('settings unavailable');
			return state.presenceEnabled;
		}
		throw new Error(`unexpected option key: ${key}`);
	})
}));

import { load } from './+page.server';

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return chain;
}

const currentUserId = 'user-1';
const currentSessionId = 'session-current';

function event(): never {
	return {
		locals: {
			user: { id: currentUserId },
			session: { id: currentSessionId }
		}
	} as never;
}

beforeEach(() => {
	state.globalRow = {
		pages: 10,
		categories: 7,
		comments_total: 2418,
		comments_unread: 1,
		friends: 55,
		friend_requests: 8,
		quotes_total: 2,
		quotes_chars: 100,
		thoughts_total: 5,
		thoughts_chars: 200,
		moments_total: 1,
		moments_chars: 300,
		pages_chars: 400,
		publish_series: [],
		category_series: [],
		comment_series: []
	};
	state.postRow = { total: 7, chars: 1000, reads: 500, likes: 50 };
	state.noteRow = { total: 3, chars: 2000, reads: 700, likes: 70 };
	state.sessions = [
		{
			id: currentSessionId,
			createdAt: new Date('2026-10-21T00:00:00.000Z'),
			ipAddress: '127.0.0.1'
		},
		{
			id: 'session-previous',
			createdAt: new Date('2026-10-20T12:00:00.000Z'),
			ipAddress: '203.0.113.5'
		}
	];
	state.selectQueue = [[state.postRow], [state.noteRow], state.sessions];
	state.presenceEnabled = true;
	state.enabledThrows = false;
	service.requireAdminRole.mockClear();
	presenceService.readSitePresence.mockReset();
	presenceService.readSitePresence.mockResolvedValue(null);
	analyticsService.readTrafficSnapshot.mockReset();
	analyticsService.readTrafficSnapshot.mockResolvedValue(null);
	Object.assign(dbMock, {
		execute: vi.fn(async () => [state.globalRow]),
		select: vi.fn(() => selectChain())
	});
});

describe('admin dashboard load', () => {
	it('reads real counters, statistics and the previous admin login', async () => {
		presenceService.readSitePresence.mockResolvedValue({ site: 5, day: 17, peak: 9 });

		const data = (await load(event())) as {
			counts: Record<string, number>;
			stats: Record<string, number>;
			lastAdminLogin: { at: string; ip: string | null; first: boolean } | null;
			charts: {
				publish: Array<{ bucket: string; posts: number; notes: number }>;
				categories: Array<{ name: string; count: number }>;
				comments: Array<{ bucket: string; total: number; approved: number }>;
			};
			siteTimezone: string;
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};

		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.counts).toEqual({ posts: 7, notes: 3, quotes: 2, thoughts: 5, moments: 1 });
		expect(data.stats).toEqual({
			pages: 10,
			categories: 7,
			comments: 2418,
			commentsUnread: 1,
			friends: 55,
			friendRequests: 8,
			characters: 4000,
			reads: 1200,
			likes: 120
		});
		expect(data.lastAdminLogin).toEqual({
			at: '2026-10-20T12:00:00.000Z',
			ip: '203.0.113.5',
			first: false
		});
		expect(data.siteTimezone).toBe('UTC');
		expect(data.charts.publish).toHaveLength(12);
		expect(data.charts.comments).toHaveLength(30);
		expect(data.charts.categories).toEqual([]);
		// Sparse SQL rows are zero-filled to the whole window so the line chart
		// cannot slope across a month that never had a publish.
		expect(
			data.charts.publish.every(
				(p: { posts: number; notes: number }) => p.posts === 0 && p.notes === 0
			)
		).toBe(true);
		expect(data.presence).toEqual({ enabled: true, site: 5, day: 17, peak: 9 });
	});

	it('renders zeroes and no login trace on an empty database', async () => {
		state.globalRow = {
			pages: 0,
			categories: 0,
			comments_total: 0,
			comments_unread: 0,
			friends: 0,
			friend_requests: 0,
			quotes_total: 0,
			quotes_chars: 0,
			thoughts_total: 0,
			thoughts_chars: 0,
			moments_total: 0,
			moments_chars: 0,
			pages_chars: 0,
			publish_series: [],
			category_series: [],
			comment_series: []
		};
		state.postRow = { total: 0, chars: 0, reads: 0, likes: 0 };
		state.noteRow = { total: 0, chars: 0, reads: 0, likes: 0 };
		state.sessions = [];
		state.selectQueue = [[state.postRow], [state.noteRow], []];

		const data = (await load(event())) as {
			counts: Record<string, number>;
			stats: Record<string, number>;
			lastAdminLogin: unknown;
			charts: {
				publish: Array<{ bucket: string; posts: number; notes: number }>;
				comments: Array<{ bucket: string; total: number; approved: number }>;
			};
		};

		expect(data.counts).toEqual({ posts: 0, notes: 0, quotes: 0, thoughts: 0, moments: 0 });
		expect(Object.values(data.stats)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(data.lastAdminLogin).toBeNull();
		expect(data.charts.publish).toHaveLength(12);
		expect(data.charts.comments).toHaveLength(30);
	});

	it('uses the current session when there is no previous admin login', async () => {
		state.selectQueue = [[state.postRow], [state.noteRow], [state.sessions[0]]];

		const data = (await load(event())) as {
			lastAdminLogin: { at: string; ip: string | null; first: boolean } | null;
		};

		expect(data.lastAdminLogin).toEqual({
			at: '2026-10-21T00:00:00.000Z',
			ip: '127.0.0.1',
			first: true
		});
	});

	it('degrades to nulls when the cache read is unavailable (cards get "—")', async () => {
		const data = (await load(event())) as {
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};
		expect(data.presence).toEqual({ enabled: true, site: null, day: null, peak: null });
	});

	it('wires the traffic card from the Sentinel snapshot without swapping fields', async () => {
		analyticsService.readTrafficSnapshot.mockResolvedValue({
			range: '24h',
			from: '2026-11-15T00:00:00.000Z',
			to: '2026-11-16T00:00:00.000Z',
			fetchedAt: Date.parse('2026-11-16T00:00:00.000Z'),
			overview: {
				requests: 11,
				bytes_in: 0,
				bytes_out: 1000,
				status: { s2xx: 9, s3xx: 0, s4xx: 2, s5xx: 0 },
				latency: { p50: 2, p95: 3, p99: 4 },
				unique_visitors: 8
			},
			paths: [
				{
					path: '/posts/hello',
					app: 'lair.example',
					requests: 3,
					bytes_out: 10,
					s4xx: 0,
					s5xx: 0,
					p50: 1,
					p95: 2
				},
				{
					path: '/style.css',
					app: 'lair.example',
					requests: 4,
					bytes_out: 10,
					s4xx: 0,
					s5xx: 0,
					p50: 1,
					p95: 2
				},
				{
					path: '/posts/missing',
					app: 'lair.example',
					requests: 2,
					bytes_out: 10,
					s4xx: 2,
					s5xx: 0,
					p50: 1,
					p95: 2
				}
			],
			series: [],
			breakdowns: {
				status: [{ value: '404', requests: 2, bytes_out: 10 }],
				referer: [],
				browser: [],
				os: [],
				device: [],
				country: []
			},
			attribution: null,
			pathsTruncated: true
		});

		const data = (await load(event())) as {
			traffic: {
				available: boolean;
				pageRequests: number | null;
				visitors: number | null;
				notFound: number | null;
			};
		};

		expect(analyticsService.readTrafficSnapshot).toHaveBeenCalledWith({ range: '24h' });
		// 3 page requests on /posts/hello + 2 on /posts/missing; style.css is
		// filtered. Visitors and 404 come from the overview/status breakdown.
		expect(data.traffic).toEqual({
			available: true,
			pageRequests: 5,
			pageRequestsLowerBound: true,
			visitors: 8,
			notFound: 2
		});
	});

	it('skips the presence read entirely when presence is disabled', async () => {
		state.presenceEnabled = false;

		const data = (await load(event())) as {
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};

		expect(presenceService.readSitePresence).not.toHaveBeenCalled();
		expect(data.presence).toEqual({ enabled: false, site: null, day: null, peak: null });
	});

	it('stops before any db work when the guard rejects (repo precedent)', async () => {
		service.requireAdminRole.mockRejectedValueOnce(new Error('denied'));
		await expect(load(event())).rejects.toThrow('denied');
		expect(dbMock.select).not.toHaveBeenCalled();
		expect(dbMock.execute).not.toHaveBeenCalled();
		expect(presenceService.readSitePresence).not.toHaveBeenCalled();
	});

	it('fails open on a settings read failure (cards render, the read still runs)', async () => {
		state.enabledThrows = true;
		presenceService.readSitePresence.mockResolvedValue({ site: 1, day: 2, peak: 3 });

		const data = (await load(event())) as {
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
			siteTimezone: string;
		};

		expect(data.presence).toEqual({ enabled: true, site: 1, day: 2, peak: 3 });
		expect(data.siteTimezone).toBe('UTC');
	});
});

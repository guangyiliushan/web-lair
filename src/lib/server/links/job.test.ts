import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
	LINK_LOCK_KEY,
	ROBOTS_BODY_BYTES,
	deriveAcceptedHosts,
	deriveRowUpdate,
	dueWhereSql,
	publicOrigin,
	ringSqlFragment,
	runLinkCheck,
	type LinkRowSnapshot,
	type LinkRunConfig
} from './job';
import { jobLockKey } from '../jobs/registry';
import type { LinkCheck } from '../../utils/link-meta';
import type { BacklinkAxis, ReachAxis } from './check-site';

const NOW = new Date('2026-10-06T12:00:00Z');

function row(overrides: Partial<LinkRowSnapshot> = {}): LinkRowSnapshot {
	return {
		id: '00000000-0000-7000-8000-000000000000',
		url: 'https://site.example/',
		host: 'site.example',
		status: 'approved',
		lostSince: null,
		backlinkUrl: 'https://site.example/links',
		failStreak: 0,
		backlinkMissingStreak: 0,
		lastOkAt: null,
		backlinkOk: true,
		backlinkCheckedAt: null,
		lastErrorKind: null,
		lastCheckedAt: null,
		updatedAt: new Date('2026-10-01T00:00:00Z'),
		...overrides
	};
}

const entry = (partial: Partial<LinkCheck>): LinkCheck => ({
	at: NOW.toISOString(),
	kind: 'reachability',
	ok: false,
	...partial
});

function outcome(
	reach: ReachAxis,
	backlink: BacklinkAxis,
	entries: LinkCheck[] = []
): {
	entries: LinkCheck[];
	reach: ReachAxis;
	backlink: BacklinkAxis;
} {
	return { entries, reach, backlink };
}

describe('deriveRowUpdate (§3 subset)', () => {
	it('approved -> outdated at the fail streak, stamping lost_since', () => {
		const plan = deriveRowUpdate(
			row({ failStreak: 2 }),
			outcome('fail', 'skipped', [entry({ err: 'timeout', note: 'x' })]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('outdated');
		expect(plan.lostSince).toBe(NOW);
		expect(plan.failStreak).toBe(3);
	});

	it('keeps approved below the streak threshold', () => {
		const plan = deriveRowUpdate(
			row({ failStreak: 1 }),
			outcome('fail', 'skipped', [entry({ err: 'dns' })]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('approved');
		expect(plan.lostSince).toBeNull();
		expect(plan.failStreak).toBe(2);
	});

	it('outdated recovers only when reachable AND backlink present', () => {
		const lostSince = new Date('2026-09-01T00:00:00Z');
		const plan = deriveRowUpdate(
			row({ status: 'outdated', lostSince, failStreak: 5 }),
			outcome('ok', 'ok'),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('approved');
		expect(plan.lostSince).toBeNull();
		expect(plan.failStreak).toBe(0);
		expect(plan.lastOkAt).toBe(NOW);
	});

	it('outdated stays outdated when the backlink axis is not ok', () => {
		const lostSince = new Date('2026-09-01T00:00:00Z');
		const plan = deriveRowUpdate(
			row({ status: 'outdated', lostSince, failStreak: 5 }),
			outcome('ok', 'missing', [entry({ kind: 'backlink', err: 'link_missing' })]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('outdated');
		expect(plan.lostSince).toBe(lostSince);
		expect(plan.failStreak).toBe(0);
		expect(plan.lastOkAt).toBe(NOW);
		expect(plan.backlinkMissingStreak).toBe(1);
		expect(plan.backlinkOk).toBe(false);
	});

	it('robots/not-counted skips move no counters and keep the status', () => {
		const plan = deriveRowUpdate(
			row({ failStreak: 2, backlinkMissingStreak: 1 }),
			outcome('skipped', 'skipped', [
				entry({ err: 'robots', note: 'disallow: /' }),
				entry({ kind: 'backlink', err: 'robots' })
			]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.failStreak).toBe(2);
		expect(plan.backlinkMissingStreak).toBe(1);
		expect(plan.status).toBe('approved');
		expect(plan.lastErrorKind).toBe('robots');
		expect(plan.lastCheckedAt).toBe(NOW);
	});

	it('clears lastErrorKind when everything is ok, prefers reach errors otherwise', () => {
		const clean = deriveRowUpdate(row(), outcome('ok', 'ok'), { failStreak: 3 }, NOW);
		expect(clean.lastErrorKind).toBeNull();

		const reachFirst = deriveRowUpdate(
			row(),
			outcome('fail', 'missing', [
				entry({ err: 'http_gone', http: 404 }),
				entry({ kind: 'backlink', err: 'link_missing' })
			]),
			{ failStreak: 3 },
			NOW
		);
		expect(reachFirst.lastErrorKind).toBe('http_gone');
	});

	it('noop backlink skips keep the previous fields intact', () => {
		const checkedAt = new Date('2026-10-01T00:00:00Z');
		const plan = deriveRowUpdate(
			row({ backlinkOk: true, backlinkCheckedAt: checkedAt, backlinkMissingStreak: 0 }),
			outcome('ok', 'skipped'),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.backlinkOk).toBe(true);
		expect(plan.backlinkCheckedAt).toBe(checkedAt);
		expect(plan.backlinkMissingStreak).toBe(0);
	});
});

describe('deriveAcceptedHosts / publicOrigin (§4.5, §2.6)', () => {
	it('folds ORIGIN and extras through normalization (www stripped, deduped)', () => {
		const hosts = deriveAcceptedHosts('https://www.Example.com/', [
			'other.example',
			'WWW.other.example'
		]);
		expect(hosts.sort()).toEqual(['example.com', 'other.example']);
		expect(deriveAcceptedHosts(null, [])).toEqual([]);
		expect(deriveAcceptedHosts(null, ['not a host!!'])).toEqual([]);
	});
});

describe('transitions pinned by review (2026-10-06)', () => {
	it('outdated keeps lost_since through a re-fail (no overwrite)', () => {
		const lostSince = new Date('2026-09-01T00:00:00Z');
		const plan = deriveRowUpdate(
			row({ status: 'outdated', lostSince, failStreak: 5 }),
			outcome('fail', 'missing', [
				entry({ err: 'timeout' }),
				entry({ kind: 'backlink', err: 'link_missing' })
			]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('outdated');
		expect(plan.lostSince).toBe(lostSince);
		expect(plan.failStreak).toBe(6);
	});

	it('outdated + skipped backlink stays outdated with backlink fields untouched', () => {
		const lostSince = new Date('2026-09-01T00:00:00Z');
		const checkedAt = new Date('2026-10-01T00:00:00Z');
		const plan = deriveRowUpdate(
			row({
				status: 'outdated',
				lostSince,
				backlinkOk: true,
				backlinkCheckedAt: checkedAt,
				backlinkMissingStreak: 0
			}),
			outcome('ok', 'skipped'),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.status).toBe('outdated');
		expect(plan.lostSince).toBe(lostSince);
		expect(plan.backlinkOk).toBe(true);
		expect(plan.backlinkCheckedAt).toBe(checkedAt);
	});

	it('inconclusive backlink leaves the backlink streak/ok untouched', () => {
		const plan = deriveRowUpdate(
			row({ backlinkOk: false, backlinkMissingStreak: 2 }),
			outcome('ok', 'inconclusive', [
				entry({ kind: 'backlink', err: 'link_missing', note: 'truncated' })
			]),
			{ failStreak: 3 },
			NOW
		);
		expect(plan.backlinkMissingStreak).toBe(2);
		expect(plan.backlinkOk).toBe(false);
		expect(plan.lastCheckedAt).toBe(NOW);
	});
});

describe('publicOrigin (§2.6)', () => {
	it('canonicalizes and rejects non-http(s)/garbage values', () => {
		const previous = process.env.ORIGIN;
		try {
			process.env.ORIGIN = 'https://www.Example.com/';
			expect(publicOrigin()).toBe('https://www.example.com');
			process.env.ORIGIN = 'ftp://nope.example/';
			expect(publicOrigin()).toBeNull();
			process.env.ORIGIN = 'not a url';
			expect(publicOrigin()).toBeNull();
			delete process.env.ORIGIN;
			expect(publicOrigin()).toBeNull();
		} finally {
			if (previous === undefined) delete process.env.ORIGIN;
			else process.env.ORIGIN = previous;
		}
	});
});

describe('SQL teeth + lock identity (review batch 2026-10-06)', () => {
	it('LINK_LOCK_KEY is derived from the registry namespace (single source)', () => {
		expect(LINK_LOCK_KEY).toBe(jobLockKey('links.check'));
		expect(LINK_LOCK_KEY).toBe('web_lair.job.links.check');
	});

	it('due predicate renders the 1x/3x cadence with int casts', () => {
		const query = new PgDialect().sqlToQuery(dueWhereSql(24));
		expect(query.sql).toContain('make_interval');
		expect(query.sql).toContain("in ('approved', 'outdated')");
		expect(query.sql).toContain('::int');
		expect(query.sql).toContain('is null');
		expect(query.sql).toContain('<= now() -');
		expect(query.sql).toContain('"check_enabled"');
		expect(query.params).toEqual([72, 24]);
	});

	it('ring fragment merges, sorts newest-first and keeps 10', () => {
		const query = new PgDialect().sqlToQuery(
			ringSqlFragment([{ at: NOW.toISOString(), kind: 'reachability', ok: true }])
		);
		expect(query.sql).toContain('jsonb_agg');
		expect(query.sql).toContain('order by ord desc');
		expect(query.sql).toMatch(/limit 10\b/);
		expect(query.sql).toContain('100000');
		expect(String(query.params[0])).toContain('reachability');
	});
});

const RUN_CONFIG: LinkRunConfig = {
	enabled: true,
	cadenceHours: 24,
	failStreak: 3,
	backlinkStreak: 2,
	graceDays: 30,
	timeoutMs: 500,
	concurrency: 2
};

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

function stubDb(passes: LinkRowSnapshot[][]) {
	const queue = [...passes];
	const updateCalls: unknown[] = [];
	const setArgs: Array<Record<string, unknown>> = [];
	const returning = vi.fn(async () => {
		updateCalls.push(1);
		return [{ id: 'x' }];
	});
	const db = {
		select: vi.fn(() => makeChain(queue.shift() ?? [])),
		update: vi.fn(() => ({
			set: vi.fn((payload: Record<string, unknown>) => {
				setArgs.push(payload);
				return { where: vi.fn(() => ({ returning })) };
			})
		}))
	};
	return { db, updateCalls, setArgs };
}

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const okFetch = () => async (url: URL | string) => {
	const href = typeof url === 'string' ? url : url.href;
	if (new URL(href).pathname === '/robots.txt') return new Response('', { status: 404 });
	return new Response('<html></html>', {
		status: 200,
		headers: { 'content-type': 'text/html' }
	});
};

const okResolve = async () => [{ address: '93.184.216.34', family: 4 }];

describe('runLinkCheck (stubbed db, review batch 2026-10-06)', () => {
	it('dry-run checks everything but never writes', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null }),
			row({ id: 'b', host: 'b.example', url: 'https://b.example/', backlinkUrl: null })
		];
		const { db, updateCalls } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(2);
		expect(summary.writes).toBe(0);
		expect(updateCalls).toHaveLength(0);
	});

	it('real runs write once per site and count writes', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null }),
			row({ id: 'b', host: 'b.example', url: 'https://b.example/', backlinkUrl: null })
		];
		const { db, updateCalls, setArgs } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(2);
		expect(summary.writes).toBe(2);
		expect(updateCalls).toHaveLength(2);
		// The UPDATE payload (ring wiring, plan -> columns, pinned
		// updated_at) must be pinned (review round 4): deleting
		// recentChecks or a counter would otherwise survive the suite.
		expect(setArgs).toHaveLength(2);
		for (const payload of setArgs) {
			expect(payload.status).toBe('approved');
			expect(payload.failStreak).toBe(0);
			expect(payload.lastCheckedAt).toBeInstanceOf(Date);
			expect(payload.recentChecks).toBeDefined();
			const ring = new PgDialect().sqlToQuery(payload.recentChecks as SQL);
			expect(ring.sql).toContain('jsonb_agg');
		}
		expect(setArgs[0].updatedAt).toEqual(rows[0].updatedAt);
	});

	it('an exhausted budget stops pulling rows (per-lane deadline)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const { db, updateCalls } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: [],
			origin: null,
			logger: silentLogger(),
			budgetMs: 0,
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.budgetExhausted).toBe(true);
		expect(summary.checked).toBe(0);
		expect(updateCalls).toHaveLength(0);
	});

	it('serializes per host (no overlapping fetches for the same host)', async () => {
		const spans: Array<{ start: number; end: number }> = [];
		const fetchImpl = async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (new URL(href).pathname === '/robots.txt') return new Response('', { status: 404 });
			const span = { start: Date.now(), end: 0 };
			spans.push(span);
			await new Promise((resolve) => setTimeout(resolve, 40));
			span.end = Date.now();
			return new Response('<html></html>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		};
		const rows = [
			row({ id: 'a', host: 's.example', url: 'https://s.example/a', backlinkUrl: null }),
			row({ id: 'b', host: 's.example', url: 'https://s.example/b', backlinkUrl: null })
		];
		const { db } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			sleepMs: async () => {},
			fetchDeps: { fetch: fetchImpl as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(2);
		expect(spans).toHaveLength(2);
		const sorted = [...spans].sort((a, b) => a.start - b.start);
		expect(sorted[0].end).toBeLessThanOrEqual(sorted[1].start);
	});

	it('skips + warns when the CAS matches no row (concurrent change)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const returning = vi.fn(async () => []);
		const whereArgs: unknown[] = [];
		const db = {
			select: vi.fn(() => makeChain([rows])),
			update: vi.fn(() => ({
				set: vi.fn(() => ({
					where: vi.fn((arg: unknown) => {
						whereArgs.push(arg);
						return { returning };
					})
				}))
			}))
		};
		const logger = silentLogger();
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(1);
		expect(summary.writes).toBe(0);
		expect(returning).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped write'));
		// The CAS predicate itself must carry the guard conjuncts
		// (mutation teeth, review batch 2026-10-06).
		expect(whereArgs).toHaveLength(1);
		const cas = new PgDialect().sqlToQuery(whereArgs[0] as SQL);
		expect(cas.sql).toContain('"status"');
		expect(cas.sql).toContain('"check_enabled"');
		expect(cas.sql).toContain('"url"');
		expect(cas.sql).toContain('"backlink_url"');
		expect(cas.sql).toContain('"last_checked_at"');
		expect(cas.sql).toContain('is not distinct from');
	});

	it('warns when ORIGIN is unset but extra accepted hosts are given', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const { db } = stubDb([rows]);
		const logger = silentLogger();
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: null,
			logger,
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ORIGIN is unset'));
		expect(summary.backlinkSkippedReason).toBeNull();
	});

	it('logs no-due only when the first pass is provably empty', async () => {
		const { db } = stubDb([[]]);
		const logger = silentLogger();
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: [],
			origin: null,
			logger,
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.due).toBe(0);
		expect(logger.info).toHaveBeenCalledWith('[links] no due sites');
	});

	it('the per-lane gate leaves late rows for the next run (budget bounds a pass)', async () => {
		const slowFetch = async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (new URL(href).pathname === '/robots.txt') return new Response('', { status: 404 });
			await new Promise((resolve) => setTimeout(resolve, 900));
			return new Response('<html></html>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		};
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null }),
			row({ id: 'b', host: 'b.example', url: 'https://b.example/', backlinkUrl: null }),
			row({ id: 'c', host: 'c.example', url: 'https://c.example/', backlinkUrl: null })
		];
		const { db } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: { ...RUN_CONFIG, concurrency: 1 },
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			budgetMs: 600,
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: slowFetch as never, resolveHost: okResolve }
		});
		// Without the per-lane deadline gate a mutated build would drain all
		// three rows (3 x 900 ms); the guard stops after the first.
		expect(summary.checked).toBe(1);
		expect(summary.budgetExhausted).toBe(true);
	});

	it('a saturated batch fully drained before the deadline stays unflagged', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const slowFetch = async (url: URL | string) => {
			const href = typeof url === 'string' ? url : url.href;
			if (new URL(href).pathname === '/robots.txt') return new Response('', { status: 404 });
			await new Promise((resolve) => setTimeout(resolve, 900));
			return new Response('<html></html>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		};
		const { db } = stubDb([rows, []]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			limitPerPass: 1,
			budgetMs: 600,
			sleepMs: async () => {},
			fetchDeps: { fetch: slowFetch as never, resolveHost: okResolve }
		});
		// Saturated batch, all rows processed: the follow-up select is
		// empty, so the run must not claim a budget stop (the pre-select
		// deadline gate was removed for exactly this, review round 3).
		expect(summary.checked).toBe(1);
		expect(summary.writes).toBe(1);
		expect(summary.budgetExhausted).toBe(false);
	});

	it('does not log no-due after a real pass (non-first empty pass)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const { db } = stubDb([rows, []]);
		const logger = silentLogger();
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger,
			limitPerPass: 1,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(1);
		expect(logger.info).not.toHaveBeenCalledWith('[links] no due sites');
	});

	it('a full batch that cannot start never spins (budget regression, review round 4)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null }),
			row({ id: 'b', host: 'b.example', url: 'https://b.example/', backlinkUrl: null })
		];
		const { db } = stubDb([rows]);
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			limitPerPass: 2,
			budgetMs: 0,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		// Exactly ONE select: nothing could start, so the loop must end. A
		// spinning loop would keep selecting (and hang this test) - this is
		// the 6892b25 regression (review round 4).
		expect(db.select).toHaveBeenCalledTimes(1);
		expect(summary.budgetExhausted).toBe(true);
		expect(summary.checked).toBe(0);
		expect(summary.due).toBe(2);
	});

	it('rows whose writes fail are not refetched in-run (bounded passes)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null }),
			row({ id: 'b', host: 'b.example', url: 'https://b.example/', backlinkUrl: null })
		];
		const returning = vi.fn(async () => {
			throw new Error('write boom');
		});
		const db = {
			select: vi.fn(() => makeChain([rows, rows])),
			update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) }))
		};
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			limitPerPass: 2,
			sleepMs: async () => {},
			fetchDeps: { fetch: okFetch() as never, resolveHost: okResolve }
		});
		expect(summary.errors).toBe(2);
		expect(summary.writes).toBe(0);
		// Second pass: both rows failed earlier this run -> filtered ->
		// nothing startable -> the loop ends (two selects total).
		expect(db.select).toHaveBeenCalledTimes(2);
	});

	it('counts and logs automatic status transitions', async () => {
		const rows = [
			row({
				id: 'a',
				host: 'a.example',
				url: 'https://a.example/',
				failStreak: 2,
				backlinkUrl: null
			})
		];
		const { db } = stubDb([rows, []]);
		const logger = silentLogger();
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger,
			limitPerPass: 1,
			sleepMs: async () => {},
			fetchDeps: {
				fetch: okFetch() as never,
				resolveHost: async () => {
					throw Object.assign(new Error('getaddrinfo ENOTFOUND a.example'), {
						code: 'ENOTFOUND'
					});
				}
			}
		});
		expect(summary.transitions).toBe(1);
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('approved -> outdated'));
		expect(summary.checked).toBe(1);
	});

	it('routes robots.txt through the pinned unit (redirect overflow falls through)', async () => {
		const rows = [
			row({ id: 'a', host: 'a.example', url: 'https://a.example/', backlinkUrl: null })
		];
		const { db } = stubDb([rows]);
		const calls: string[] = [];
		const fetchImpl = async (url: URL | string) => {
			const href = String(url);
			calls.push(href);
			if (href.endsWith('/robots.txt')) {
				return new Response(null, { status: 301, headers: { location: '/robots.txt' } });
			}
			return new Response('<html></html>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		};
		const summary = await runLinkCheck({
			db: db as never,
			config: RUN_CONFIG,
			acceptedHosts: ['ok.example'],
			origin: 'https://ok.example',
			logger: silentLogger(),
			dryRun: true,
			sleepMs: async () => {},
			fetchDeps: { fetch: fetchImpl as never, resolveHost: okResolve }
		});
		expect(summary.checked).toBe(1);
		// 5-hop limit: 6 robots attempts, then the page fetch.
		expect(calls.filter((href) => href.endsWith('/robots.txt'))).toHaveLength(6);
		expect(ROBOTS_BODY_BYTES).toBe(512 * 1024);
	});
});

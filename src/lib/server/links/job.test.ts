import { describe, expect, it } from 'vitest';
import { deriveAcceptedHosts, deriveRowUpdate, type LinkRowSnapshot } from './job';
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

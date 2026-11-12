import { describe, expect, it, vi } from 'vitest';

// The service imports the app db handle; the pure rules under test never
// touch it. Same seam as projects/service.test.ts (fake module, no env).
vi.mock('$lib/server/db', () => ({ db: {} }));

import {
	LinkAdminError,
	MANUAL_ACTION_SOURCES,
	MANUAL_CHECK_COOLDOWN_MS,
	MANUAL_TRANSITIONS,
	canManualTransition,
	clampSortOrder,
	computeRowBadges,
	derivePrecheckBadge,
	planManualTransition,
	type ManualAction,
	type ManualTransitionInput
} from './admin';
import { LINK_STATUSES, type LinkStatus } from '../../utils/link-meta';

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof LinkAdminError) return err.code;
		throw err;
	}
	throw new Error('expected the call to throw');
}

const DAY = 86_400_000;

describe('links admin manual state machine (plan §3, manual edges)', () => {
	it('declares exactly the five manual edges and refuses everything else', () => {
		expect(MANUAL_TRANSITIONS).toEqual([
			['pending', 'approved'],
			['pending', 'rejected'],
			['approved', 'banned'],
			['outdated', 'banned'],
			['banned', 'approved']
		]);
		const allowed = new Set(MANUAL_TRANSITIONS.map(([a, b]) => `${a}>${b}`));
		for (const from of LINK_STATUSES) {
			for (const to of LINK_STATUSES) {
				expect(canManualTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
			}
		}
	});

	it('approve: a passing backlink check needs no note', () => {
		const patch = planManualTransition({ status: 'pending', backlinkOk: true }, 'approve');
		expect(patch).toEqual({ status: 'approved', reason: null, lostSince: null });
	});

	it('approve: an unverified backlink requires a note, stored as override', () => {
		const patch = planManualTransition({ status: 'pending', backlinkOk: null }, 'approve', {
			note: '  checked by hand  '
		});
		expect(patch.reason).toBe('override: checked by hand');
		expect(patch.status).toBe('approved');

		expect(
			codeOf(() => planManualTransition({ status: 'pending', backlinkOk: false }, 'approve'))
		).toBe('note-required');
		expect(
			codeOf(() =>
				planManualTransition({ status: 'pending', backlinkOk: false }, 'approve', { note: '   ' })
			)
		).toBe('note-required');
	});

	it('approve: only pending rows may be approved', () => {
		for (const status of LINK_STATUSES.filter((s) => s !== 'pending')) {
			expect(codeOf(() => planManualTransition({ status, backlinkOk: true }, 'approve'))).toBe(
				'bad-status'
			);
		}
	});

	it('reject: pending only, reason required', () => {
		expect(
			planManualTransition({ status: 'pending', backlinkOk: null }, 'reject', { reason: 'spam' })
		).toEqual({ status: 'rejected', reason: 'spam', lostSince: null });
		expect(
			codeOf(() => planManualTransition({ status: 'pending', backlinkOk: null }, 'reject'))
		).toBe('reason-required');
		expect(
			codeOf(() =>
				planManualTransition({ status: 'approved', backlinkOk: true }, 'reject', { reason: 'x' })
			)
		).toBe('bad-status');
	});

	it('ban: approved/outdated only, reason required, checks paused, lost_since cleared', () => {
		for (const status of ['approved', 'outdated'] as const) {
			const patch = planManualTransition({ status, backlinkOk: true }, 'ban', { reason: '违规' });
			expect(patch).toEqual({
				status: 'banned',
				reason: '违规',
				// CHECK 4: banned rows must not carry lost_since.
				lostSince: null,
				checkEnabled: false
			});
		}
		expect(
			codeOf(() => planManualTransition({ status: 'approved', backlinkOk: true }, 'ban'))
		).toBe('reason-required');
		expect(
			codeOf(() =>
				planManualTransition({ status: 'pending', backlinkOk: true }, 'ban', { reason: 'x' })
			)
		).toBe('bad-status');
	});

	it('restore: banned only, same approval guard, checks re-enabled', () => {
		const patch = planManualTransition({ status: 'banned', backlinkOk: true }, 'restore');
		expect(patch).toEqual({
			status: 'approved',
			reason: null,
			lostSince: null,
			checkEnabled: true
		});
		expect(
			codeOf(() => planManualTransition({ status: 'banned', backlinkOk: null }, 'restore'))
		).toBe('note-required');
		expect(
			codeOf(() => planManualTransition({ status: 'approved', backlinkOk: true }, 'restore'))
		).toBe('bad-status');
	});

	it('covers every action against every status without inventing an edge', () => {
		const actions: ManualAction[] = ['approve', 'reject', 'ban', 'restore'];
		const targets: Record<ManualAction, LinkStatus> = {
			approve: 'approved',
			reject: 'rejected',
			ban: 'banned',
			restore: 'approved'
		};
		const input: ManualTransitionInput = { note: 'n', reason: 'r' };
		for (const action of actions) {
			for (const status of LINK_STATUSES) {
				const allowed = MANUAL_ACTION_SOURCES[action].includes(status);
				if (allowed) {
					expect(planManualTransition({ status, backlinkOk: true }, action, input).status).toBe(
						targets[action]
					);
				} else {
					expect(
						codeOf(() => planManualTransition({ status, backlinkOk: true }, action, input))
					).toBe('bad-status');
				}
			}
		}
	});
});

describe('links admin derived badges (plan §2.5)', () => {
	const now = new Date('2026-10-26T00:00:00Z');

	it('flags a two-strike backlink loss on live rows only', () => {
		const base = {
			backlinkMissingStreak: 2,
			lastErrorKind: null,
			lastOkAt: now,
			lostSince: null
		};
		expect(computeRowBadges({ ...base, status: 'approved' }, now, 30).backlinkLost).toBe(true);
		expect(computeRowBadges({ ...base, status: 'outdated' }, now, 30).backlinkLost).toBe(true);
		expect(computeRowBadges({ ...base, status: 'rejected' }, now, 30).backlinkLost).toBe(false);
	});

	it('flags a WAF block only after seven days without a success', () => {
		const row = {
			status: 'approved',
			backlinkMissingStreak: 0,
			lastErrorKind: 'waf',
			lostSince: null
		};
		expect(computeRowBadges({ ...row, lastOkAt: null }, now, 30).blocked).toBe(true);
		expect(
			computeRowBadges({ ...row, lastOkAt: new Date(now.getTime() - 8 * DAY) }, now, 30).blocked
		).toBe(true);
		expect(
			computeRowBadges({ ...row, lastOkAt: new Date(now.getTime() - 1 * DAY) }, now, 30).blocked
		).toBe(false);
		expect(
			computeRowBadges(
				{ ...row, lastErrorKind: 'timeout', lastOkAt: new Date(now.getTime() - 8 * DAY) },
				now,
				30
			).blocked
		).toBe(false);
	});

	it('counts down the prune grace and turns purgeSoon on in the last week', () => {
		const base = {
			status: 'outdated',
			backlinkMissingStreak: 0,
			lastErrorKind: null,
			lastOkAt: null
		};
		const fresh = computeRowBadges(
			{ ...base, lostSince: new Date(now.getTime() - 10 * DAY) },
			now,
			30
		);
		expect(fresh.daysToPurge).toBe(20);
		expect(fresh.purgeSoon).toBe(false);

		const late = computeRowBadges(
			{ ...base, lostSince: new Date(now.getTime() - 25 * DAY) },
			now,
			30
		);
		expect(late.daysToPurge).toBe(5);
		expect(late.purgeSoon).toBe(true);

		const approved = computeRowBadges({ ...base, status: 'approved', lostSince: null }, now, 30);
		expect(approved.daysToPurge).toBeNull();
		expect(approved.purgeSoon).toBe(false);
	});
});

describe('pending precheck badge', () => {
	const older = new Date('2026-11-09T00:00:00Z');
	const newer = new Date('2026-11-10T00:00:00Z');
	const run = (
		overrides: Partial<{
			status: 'running' | 'completed' | 'stale';
			ok: boolean | null;
			errorKind: string | null;
			note: string | null;
			startedAt: Date;
		}>
	) => ({
		status: 'completed' as const,
		ok: true,
		errorKind: null,
		note: null,
		startedAt: newer,
		...overrides
	});

	it('takes the newest non-stale run', () => {
		expect(
			derivePrecheckBadge([
				run({ ok: false, errorKind: 'timeout', startedAt: older }),
				run({ ok: true, startedAt: newer })
			])
		).toMatchObject({ status: 'completed', ok: true });
	});

	it('reports a running newest run', () => {
		expect(
			derivePrecheckBadge([run({ startedAt: older }), run({ status: 'running', ok: null })])
		).toMatchObject({ status: 'running' });
	});

	it('lets a stale newest run mask an older pass', () => {
		expect(
			derivePrecheckBadge([
				run({ ok: true, startedAt: older }),
				run({ status: 'stale', ok: null, startedAt: newer, note: 'precheck: aborted' })
			])
		).toMatchObject({ status: 'stale', ok: false, note: 'precheck: aborted' });
	});

	it('surfaces a lone stale run instead of pretending there is no evidence', () => {
		expect(derivePrecheckBadge([run({ status: 'stale', ok: null })])).toMatchObject({
			status: 'stale',
			ok: false
		});
		expect(derivePrecheckBadge([])).toBeNull();
	});

	it('surfaces the failed axis', () => {
		expect(derivePrecheckBadge([run({ ok: false, errorKind: 'link_missing' })])).toMatchObject({
			ok: false,
			errorKind: 'link_missing'
		});
	});

	it('only badges pending rows', () => {
		const badge = {
			status: 'completed' as const,
			ok: true,
			errorKind: null,
			note: null,
			at: newer
		};
		const base = {
			backlinkMissingStreak: 0,
			lastErrorKind: null,
			lastOkAt: null,
			lostSince: null
		};
		expect(computeRowBadges({ ...base, status: 'approved' }, newer, 30, badge).precheck).toBeNull();
		expect(computeRowBadges({ ...base, status: 'pending' }, newer, 30, badge).precheck).toEqual(
			badge
		);
		expect(computeRowBadges({ ...base, status: 'pending' }, newer, 30, null).precheck).toBeNull();
	});
});

describe('links admin sort clamp', () => {
	it('keeps hand-entered sort keys inside 0..9999', () => {
		expect(clampSortOrder(undefined)).toBe(0);
		expect(clampSortOrder(null)).toBe(0);
		expect(clampSortOrder(Number.NaN)).toBe(0);
		expect(clampSortOrder(-5)).toBe(0);
		expect(clampSortOrder(3.7)).toBe(3);
		expect(clampSortOrder(12_345)).toBe(9999);
	});
});

describe('manual check cooldown', () => {
	it('is one minute (G4: a double-click is not a policy)', () => {
		expect(MANUAL_CHECK_COOLDOWN_MS).toBe(60_000);
	});
});

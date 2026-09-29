import { describe, expect, it } from 'vitest';
import { CronExprError, dueWindow } from './due';

/**
 * Cron math for the drain (plan §4.1 / §4.8 / §4.9). The probe that fixed the
 * boundary semantics: cron-parser's `prev()` is exclusive of currentDate, so
 * the drain nudges +1ms to keep the window right-closed - the test pinning
 * "a due exactly at now counts" is the one that guards it.
 */
describe('dueWindow cron validation', () => {
	it('rejects 6-field (seconds) expressions', () => {
		expect(() => dueWindow('* * * * * *', 'UTC', new Date(0), new Date(1000))).toThrow(
			CronExprError
		);
	});

	it('rejects malformed field counts', () => {
		expect(() => dueWindow('* * *', 'UTC', new Date(0), new Date(1000))).toThrow(CronExprError);
	});
});

describe('dueWindow', () => {
	const now = new Date('2026-01-10T12:00:00.000Z');

	it('counts dues in (water, now] and returns the latest', () => {
		const snapshot = dueWindow('30 1 * * *', 'UTC', new Date('2026-01-07T01:30:00.000Z'), now);
		expect(snapshot?.latestDue.toISOString()).toBe('2026-01-10T01:30:00.000Z');
		expect(snapshot?.dues).toBe(3);
	});

	it('treats a due exactly at `now` as due (right-closed window)', () => {
		const snapshot = dueWindow(
			'30 1 * * *',
			'UTC',
			new Date('2026-01-09T01:30:00.000Z'),
			new Date('2026-01-10T01:30:00.000Z')
		);
		expect(snapshot?.dues).toBe(1);
		expect(snapshot?.latestDue.toISOString()).toBe('2026-01-10T01:30:00.000Z');
	});

	it('excludes a due exactly at the watermark (left-open window)', () => {
		expect(dueWindow('30 1 * * *', 'UTC', new Date('2026-01-10T01:30:00.000Z'), now)).toBeNull();
	});

	it('returns null when the watermark is not in the past', () => {
		expect(dueWindow('30 1 * * *', 'UTC', now, now)).toBeNull();
		expect(dueWindow('30 1 * * *', 'UTC', new Date(now.getTime() + 1000), now)).toBeNull();
	});

	it('fires on the schedule timezone wall clock, not UTC', () => {
		// 09:00 Asia/Tokyo == 00:00 UTC.
		const snapshot = dueWindow(
			'0 9 * * *',
			'Asia/Tokyo',
			new Date('2026-01-08T05:00:00.000Z'),
			new Date('2026-01-10T05:00:00.000Z')
		);
		expect(snapshot?.dues).toBe(2);
		expect(snapshot?.latestDue.toISOString()).toBe('2026-01-10T00:00:00.000Z');
	});

	it('handles DST transitions (America/New_York spring forward)', () => {
		// Noon ET never falls in the skipped hour; UTC offset shifts from -5 to -4.
		const snapshot = dueWindow(
			'0 12 * * *',
			'America/New_York',
			new Date('2026-03-06T17:00:00.000Z'),
			new Date('2026-03-10T20:00:00.000Z')
		);
		expect(snapshot?.dues).toBe(4);
		expect(snapshot?.latestDue.toISOString()).toBe('2026-03-10T16:00:00.000Z');
	});

	it('throws on an invalid timezone so drain can isolate the row', () => {
		expect(() => dueWindow('0 9 * * *', 'Not/AZone', new Date(0), new Date(1000))).toThrow();
	});

	it('caps the backwards scan at 500 dues; latest stays correct, missed saturates', () => {
		// 501 minutely dues in the window (11:40..20:00 over a 501-minute
		// window) - the count saturates at the cap, the latest due does not.
		const snapshot = dueWindow(
			'* * * * *',
			'UTC',
			new Date('2026-01-10T11:39:00.000Z'),
			new Date('2026-01-10T20:00:00.000Z')
		);
		expect(snapshot?.dues).toBe(500);
		expect(snapshot?.latestDue.toISOString()).toBe('2026-01-10T20:00:00.000Z');
	});
});

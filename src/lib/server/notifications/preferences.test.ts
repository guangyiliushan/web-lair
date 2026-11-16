import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	enabledChannels,
	parseNotificationPreferences,
	readNotificationPreferences
} from './preferences';
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_TYPES, shouldAlertJobFailure } from './events';

/** M6 P5 preferences (decision N8): comment/job/ops email on, Bark off. */
describe('DEFAULT_NOTIFICATION_PREFERENCES', () => {
	it('ships email on and Bark off for every group', () => {
		for (const group of ['comment', 'job', 'ops'] as const) {
			expect(DEFAULT_NOTIFICATION_PREFERENCES[group]).toEqual({ email: true, bark: false });
		}
	});
});

describe('parseNotificationPreferences', () => {
	it('returns the defaults for a missing row', () => {
		expect(parseNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
	});

	it('falls back to the defaults for a corrupt row', () => {
		expect(parseNotificationPreferences({ comment: { email: 'yes' } })).toEqual(
			DEFAULT_NOTIFICATION_PREFERENCES
		);
	});

	it('does not hand out a shared mutable default object', () => {
		const first = parseNotificationPreferences(null);
		first.comment.email = false;
		expect(parseNotificationPreferences(null).comment.email).toBe(true);
	});
});

describe('readNotificationPreferences', () => {
	it('reads the options row through the structural seam (single row)', async () => {
		const rows = [
			{
				value: {
					comment: { email: false, bark: true },
					job: { email: true, bark: false },
					ops: { email: false, bark: false }
				}
			}
		];
		const limits: number[] = [];
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async (count: number) => {
							limits.push(count);
							return rows;
						}
					})
				})
			})
		};
		const preferences = await readNotificationPreferences(db as never);
		expect(limits).toEqual([1]);
		expect(preferences.comment).toEqual({ email: false, bark: true });
	});
});

describe('enabledChannels', () => {
	it('narrows an event to the channels its group enables', () => {
		const preferences = parseNotificationPreferences(null);
		expect(enabledChannels('comment.pending', preferences)).toEqual(['email']);
	});

	it('returns both channels when Bark is switched on', () => {
		const preferences = parseNotificationPreferences({
			comment: { email: true, bark: true },
			job: { email: true, bark: false },
			ops: { email: true, bark: false }
		});
		expect(enabledChannels('comment.pending', preferences)).toEqual(['email', 'bark']);
	});
});

describe('notification event roster', () => {
	it('uses names the table CHECK accepts (dotted lowercase)', () => {
		for (const type of NOTIFICATION_EVENT_TYPES) {
			expect(type).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
		}
	});

	it('declares only supported channels and a known group', () => {
		for (const type of NOTIFICATION_EVENT_TYPES) {
			const definition = NOTIFICATION_EVENTS[type];
			expect(['comment', 'job', 'ops']).toContain(definition.group);
			expect(definition.channels.length).toBeGreaterThan(0);
			for (const channel of definition.channels) expect(['email', 'bark']).toContain(channel);
		}
	});

	it('registers the two M6 first-batch events and the P4 probe events', () => {
		expect(NOTIFICATION_EVENT_TYPES).toEqual(
			expect.arrayContaining([
				'comment.pending',
				'job.failed',
				'system.disk_high',
				'system.memory_high',
				'mail.probe.failed'
			])
		);
	});

	it('alerts on the whitelisted data-integrity job only (decision N7)', () => {
		expect(shouldAlertJobFailure('media.audit')).toBe(true);
		expect(shouldAlertJobFailure('jobs.prune')).toBe(false);
		expect(shouldAlertJobFailure('')).toBe(false);
	});
});

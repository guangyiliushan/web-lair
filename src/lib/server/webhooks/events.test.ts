import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_ROSTER, isWebhookEventName } from './events';

/**
 * Roster teeth: the registry must stay exactly the events the producers emit
 * (job-scripts.ts emits job.save/job.fork/job.revert/job.delete; maintenance
 * routes emit job.run; job-schedules.ts emits the schedule family), and every
 * name must satisfy the activities CHECK format the schema pins.
 */
describe('WEBHOOK_EVENT_ROSTER', () => {
	it('holds the nine v1 events', () => {
		expect([...WEBHOOK_EVENT_ROSTER].sort()).toEqual([
			'job.delete',
			'job.fork',
			'job.revert',
			'job.run',
			'job.save',
			'schedule.create',
			'schedule.delete',
			'schedule.toggle',
			'schedule.update'
		]);
	});

	it('every name satisfies the activities CHECK format', () => {
		for (const name of WEBHOOK_EVENT_ROSTER) {
			expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
		}
	});

	it('classifies roster members and strangers', () => {
		expect(isWebhookEventName('job.run')).toBe(true);
		expect(isWebhookEventName('schedule.toggle')).toBe(true);
		for (const stranger of ['page.saved', 'job', 'job.*', 'Job.Run', 'job.run ']) {
			expect(isWebhookEventName(stranger)).toBe(false);
		}
	});
});

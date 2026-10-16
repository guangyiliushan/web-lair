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

	it('producer call sites stay inside the roster (source scan, review round-1)', async () => {
		// The literal-string emitters under these roots must all be roster
		// members; a new producer event that forgets the roster turns red.
		// (The `job.save`/`job.fork` ternary in job-scripts.ts is not a literal
		// match - it is pinned by the roster literals and the jobs tests.)
		const { readFileSync, readdirSync, statSync } = await import('node:fs');
		const { join } = await import('node:path');
		const roots = ['src/lib/server/jobs', 'src/routes/(admin)/admin/maintenance'];
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
			}
		};
		roots.forEach(walk);
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/\bevent:\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)) {
				if (!isWebhookEventName(match[1])) offenders.push(`${file}: ${match[1]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

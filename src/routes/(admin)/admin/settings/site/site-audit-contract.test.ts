import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_ROSTER } from '$lib/server/webhooks/events';

/**
 * W5.7 audit contract: `site.update` must satisfy the activities CHECK
 * (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`) and must NOT join the webhook
 * roster - settings changes are local facts, so the fan-out inserts zero
 * delivery rows (R-7 / §3A.4).
 */
describe('site.update audit contract (W5.7)', () => {
	it('has the two-segment shape the activities CHECK requires', () => {
		expect('site.update').toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
	});

	it('is not a webhook event, so a save fans out to zero deliveries', () => {
		expect(WEBHOOK_EVENT_ROSTER as readonly string[]).not.toContain('site.update');
	});
});

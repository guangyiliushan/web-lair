import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_ROSTER } from '$lib/server/webhooks/events';
import { SITE_UPDATE_EVENT } from '$lib/server/settings/site-events';

/**
 * Audit contract: `site.update` must satisfy the activities CHECK
 * (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`) and must NOT join the webhook roster -
 * settings changes are local facts, so the fan-out inserts zero delivery rows.
 */
describe('site.update audit contract', () => {
	it('has the two-segment shape the activities CHECK requires', () => {
		expect(SITE_UPDATE_EVENT).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
	});

	it('is not a webhook event, so a save fans out to zero deliveries', () => {
		expect(WEBHOOK_EVENT_ROSTER as readonly string[]).not.toContain(SITE_UPDATE_EVENT);
	});
});

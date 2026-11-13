import { describe, expect, it } from 'vitest';
import { evaluateSecretAlerts, type ActivityRow, type UsageRow } from './alert-rules.ts';

const NOW = new Date('2026-11-13T12:00:00Z');

function minutesAgo(minutes: number): Date {
	return new Date(NOW.getTime() - minutes * 60_000);
}

function activity(
	event: string,
	options: { minutes?: number; provider?: string; actorId?: string | null } = {}
): ActivityRow {
	return {
		event,
		createdAt: minutesAgo(options.minutes ?? 1),
		actorId: options.actorId ?? null,
		payload: options.provider ? { provider: options.provider } : null
	};
}

function usage(provider: string, status: string, minutes = 1): UsageRow {
	return { provider, status, createdAt: minutesAgo(minutes) };
}

describe('secret alert rules (A3)', () => {
	it('fires on any decrypt failure inside 5 minutes', () => {
		const alerts = evaluateSecretAlerts({
			activities: [activity('ai.key_decrypt_failed', { provider: 'openai', minutes: 4 })],
			usage: [],
			now: NOW
		});
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ rule: 'decrypt_failed', subject: 'openai', count: 1 });
	});

	it('fires on a webhook decrypt failure too (same keyring, own event family)', () => {
		const alerts = evaluateSecretAlerts({
			activities: [activity('webhook.key_decrypt_failed', { provider: 'ops-hook', minutes: 2 })],
			usage: [],
			now: NOW
		});
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ rule: 'decrypt_failed', subject: 'ops-hook', count: 1 });
	});

	it('ignores a decrypt failure older than 5 minutes', () => {
		const alerts = evaluateSecretAlerts({
			activities: [activity('ai.key_decrypt_failed', { provider: 'openai', minutes: 6 })],
			usage: [],
			now: NOW
		});
		expect(alerts).toEqual([]);
	});

	it('fires on 3 missing-key failures for one provider with no success', () => {
		const alerts = evaluateSecretAlerts({
			activities: [
				activity('ai.key_missing', { provider: 'openai', minutes: 9 }),
				activity('ai.key_missing', { provider: 'openai', minutes: 5 }),
				activity('ai.key_missing', { provider: 'openai', minutes: 1 })
			],
			usage: [usage('openai', 'failure')],
			now: NOW
		});
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ rule: 'missing', subject: 'openai', count: 3 });
	});

	it('does not fire a missing alert when the provider succeeded in the window', () => {
		const alerts = evaluateSecretAlerts({
			activities: [
				activity('ai.key_missing', { provider: 'openai', minutes: 9 }),
				activity('ai.key_missing', { provider: 'openai', minutes: 5 }),
				activity('ai.key_missing', { provider: 'openai', minutes: 1 })
			],
			usage: [usage('openai', 'success', 2)],
			now: NOW
		});
		expect(alerts).toEqual([]);
	});

	it('keeps providers separate and below the threshold', () => {
		const alerts = evaluateSecretAlerts({
			activities: [
				activity('ai.key_missing', { provider: 'openai' }),
				activity('ai.key_missing', { provider: 'deepl' }),
				activity('ai.key_missing', { provider: 'deepl' })
			],
			usage: [],
			now: NOW
		});
		expect(alerts).toEqual([]);
	});

	it('fires on 3 denied attempts by one actor in 10 minutes', () => {
		const alerts = evaluateSecretAlerts({
			activities: [
				activity('ai.key_denied', { actorId: 'user-1', minutes: 9 }),
				activity('ai.key_denied', { actorId: 'user-1', minutes: 4 }),
				activity('ai.key_denied', { actorId: 'user-1', minutes: 1 }),
				activity('ai.key_denied', { actorId: 'user-2', minutes: 1 })
			],
			usage: [],
			now: NOW
		});
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ rule: 'denied', subject: 'user-1', count: 3 });
	});

	it('treats anonymous denials as one actor instead of dropping them', () => {
		const alerts = evaluateSecretAlerts({
			activities: [
				activity('ai.key_denied', { minutes: 3 }),
				activity('ai.key_denied', { minutes: 2 }),
				activity('ai.key_denied', { minutes: 1 })
			],
			usage: [],
			now: NOW
		});
		expect(alerts[0]).toMatchObject({ rule: 'denied', subject: 'anonymous', count: 3 });
	});

	it('returns nothing for an empty window', () => {
		expect(evaluateSecretAlerts({ activities: [], usage: [], now: NOW })).toEqual([]);
	});
});

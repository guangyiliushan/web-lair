import { describe, expect, it } from 'vitest';
import {
	WEBHOOK_BASE_DELAY_MS,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_DELAY_MS,
	classifyWebhookResponse,
	parseRetryAfter,
	planWebhookRetry
} from './retry';

describe('webhook response classification (W9.4)', () => {
	it('2xx succeeds', () => {
		expect(classifyWebhookResponse(200)).toBe('success');
		expect(classifyWebhookResponse(204)).toBe('success');
		expect(classifyWebhookResponse(299)).toBe('success');
	});

	it('3xx is permanent - redirects are never followed', () => {
		expect(classifyWebhookResponse(301)).toBe('permanent');
		expect(classifyWebhookResponse(302)).toBe('permanent');
		expect(classifyWebhookResponse(307)).toBe('permanent');
	});

	it('408/429/5xx retry', () => {
		expect(classifyWebhookResponse(408)).toBe('retryable');
		expect(classifyWebhookResponse(429)).toBe('retryable');
		expect(classifyWebhookResponse(500)).toBe('retryable');
		expect(classifyWebhookResponse(503)).toBe('retryable');
	});

	it('other 4xx are permanent', () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			expect(classifyWebhookResponse(status), String(status)).toBe('permanent');
		}
	});

	it('410 disables the endpoint (Standard Webhooks etiquette)', () => {
		expect(classifyWebhookResponse(410)).toBe('disable');
	});
});

describe('webhook backoff (W9.4)', () => {
	const noJitter = () => 0.5;

	it('doubles from the one-minute base', () => {
		const delays = [1, 2, 3, 4, 5].map(
			(attempt) => planWebhookRetry(attempt, { random: noJitter }).delayMs
		);
		expect(delays).toEqual([
			WEBHOOK_BASE_DELAY_MS,
			2 * WEBHOOK_BASE_DELAY_MS,
			4 * WEBHOOK_BASE_DELAY_MS,
			8 * WEBHOOK_BASE_DELAY_MS,
			16 * WEBHOOK_BASE_DELAY_MS
		]);
	});

	it('caps the delay', () => {
		const planned = planWebhookRetry(5, { random: noJitter });
		expect(planned.delayMs).toBeLessThanOrEqual(WEBHOOK_MAX_DELAY_MS);
		const capped = planWebhookRetry(5, { random: () => 1 });
		expect(capped.delayMs).toBeLessThanOrEqual(WEBHOOK_MAX_DELAY_MS);
	});

	it('applies jitter within the configured band', () => {
		const low = planWebhookRetry(1, { random: () => 0 }).delayMs;
		const high = planWebhookRetry(1, { random: () => 1 }).delayMs;
		expect(low).toBe(Math.round(WEBHOOK_BASE_DELAY_MS * 0.8));
		expect(high).toBe(Math.round(WEBHOOK_BASE_DELAY_MS * 1.2));
	});

	it('stops after the attempt budget', () => {
		expect(planWebhookRetry(WEBHOOK_MAX_ATTEMPTS - 1, { random: noJitter }).retry).toBe(true);
		expect(planWebhookRetry(WEBHOOK_MAX_ATTEMPTS, { random: noJitter })).toEqual({
			retry: false,
			delayMs: 0
		});
		expect(planWebhookRetry(WEBHOOK_MAX_ATTEMPTS + 3, { random: noJitter }).retry).toBe(false);
	});

	it('honours a longer Retry-After but keeps the cap', () => {
		expect(planWebhookRetry(1, { random: noJitter, retryAfterMs: 5 * 60_000 }).delayMs).toBe(
			5 * 60_000
		);
		// Shorter than the backoff: the backoff wins.
		expect(planWebhookRetry(2, { random: noJitter, retryAfterMs: 30_000 }).delayMs).toBe(
			2 * WEBHOOK_BASE_DELAY_MS
		);
		expect(planWebhookRetry(1, { random: noJitter, retryAfterMs: 24 * 3_600_000 }).delayMs).toBe(
			WEBHOOK_MAX_DELAY_MS
		);
	});

	it('parses Retry-After seconds and HTTP dates', () => {
		const now = new Date('2026-11-14T12:00:00Z');
		expect(parseRetryAfter('120', now)).toBe(120_000);
		expect(parseRetryAfter('0', now)).toBe(0);
		expect(parseRetryAfter('Sat, 14 Nov 2026 12:01:00 GMT', now)).toBe(60_000);
		expect(parseRetryAfter('Sat, 14 Nov 2026 11:00:00 GMT', now)).toBe(0);
		expect(parseRetryAfter('later', now)).toBeNull();
		expect(parseRetryAfter(null, now)).toBeNull();
		expect(parseRetryAfter('', now)).toBeNull();
	});
});

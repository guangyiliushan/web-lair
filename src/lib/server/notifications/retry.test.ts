import { describe, expect, it } from 'vitest';
import {
	NOTIFICATION_MAX_ATTEMPTS,
	NOTIFICATION_RETRY_DELAYS_MS,
	planNotificationRetry
} from './retry';

/** M6 P5 retry schedule (plan §3.2): 1m / 5m / 15m; one send + three retries. */
describe('planNotificationRetry', () => {
	it('uses the documented 1m/5m/15m delays', () => {
		expect(NOTIFICATION_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
	});

	it('retries after attempt 1 in one minute', () => {
		expect(planNotificationRetry(1)).toEqual({ retry: true, delayMs: 60_000 });
	});

	it('retries after attempt 2 in five minutes', () => {
		expect(planNotificationRetry(2)).toEqual({ retry: true, delayMs: 300_000 });
	});

	it('retries after attempt 3 in fifteen minutes', () => {
		expect(planNotificationRetry(3)).toEqual({ retry: true, delayMs: 900_000 });
	});

	it('goes terminal after the fourth attempt', () => {
		expect(NOTIFICATION_MAX_ATTEMPTS).toBe(4);
		expect(planNotificationRetry(4)).toEqual({ retry: false, delayMs: 0 });
		expect(planNotificationRetry(5)).toEqual({ retry: false, delayMs: 0 });
	});

	it('treats a nonsensical attempt count as terminal (no retry storm)', () => {
		expect(planNotificationRetry(0)).toEqual({ retry: false, delayMs: 0 });
		expect(planNotificationRetry(Number.NaN)).toEqual({ retry: false, delayMs: 0 });
	});
});

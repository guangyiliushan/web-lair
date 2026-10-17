import { describe, expect, it, vi } from 'vitest';

/**
 * Pure helpers of the subscription service (D-2). The DB state machine is
 * exercised end-to-end by `e2e/subscribe.e2e.ts` against the real schema; here
 * we pin the input contract so a loosened regex cannot slip through.
 */
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/system', () => ({ subscriptions: {} }));

import {
	isSubscriptionLang,
	isSubscriptionToken,
	newSubscriptionToken,
	normalizeEmail
} from './subscriptions';

describe('subscription input contract', () => {
	it('normalizes case and surrounding whitespace', () => {
		expect(normalizeEmail('  Reader@Example.COM ')).toBe('reader@example.com');
	});

	it('rejects malformed addresses', () => {
		for (const value of ['', ' ', 'no-at-sign', 'a@b', 'a b@c.d', '@example.com', 'a@.com']) {
			expect(normalizeEmail(value)).toBeNull();
		}
	});

	it('rejects addresses longer than 254 characters', () => {
		const local = 'a'.repeat(250);
		expect(normalizeEmail(`${local}@example.com`)).toBeNull();
	});

	it('mints 32-byte base64url tokens that satisfy the token guard', () => {
		const token = newSubscriptionToken();
		expect(token).toHaveLength(43);
		expect(isSubscriptionToken(token)).toBe(true);
		expect(newSubscriptionToken()).not.toBe(token);
	});

	it('rejects tokens that are not 43 base64url characters', () => {
		expect(isSubscriptionToken('')).toBe(false);
		expect(isSubscriptionToken('short')).toBe(false);
		expect(isSubscriptionToken('a'.repeat(43))).toBe(true);
		expect(isSubscriptionToken('a'.repeat(42) + '!')).toBe(false);
	});

	it('accepts only the three site languages', () => {
		expect(isSubscriptionLang('en')).toBe(true);
		expect(isSubscriptionLang('zh-cn')).toBe(true);
		expect(isSubscriptionLang('ja')).toBe(true);
		expect(isSubscriptionLang('de')).toBe(false);
	});
});

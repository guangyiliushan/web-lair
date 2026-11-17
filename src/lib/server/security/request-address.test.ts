import { describe, expect, it } from 'vitest';
import { credentialBucketKey, requestAddress, requestIp } from './request-address';

/**
 * Credentials buckets must separate accounts behind one
 * address, and the email must never appear in the key material.
 */
describe('request address helpers', () => {
	it('falls back to unknown / null when the adapter cannot resolve an address', () => {
		expect(requestAddress(() => '')).toBe('unknown');
		expect(
			requestAddress(() => {
				throw new Error('no address');
			})
		).toBe('unknown');
		expect(requestIp(() => '')).toBeNull();
		expect(
			requestIp(() => {
				throw new Error('no address');
			})
		).toBeNull();
	});

	it('keys credentials by address and a non-reversible email digest', () => {
		const a = credentialBucketKey('login', '4:c0000201', 'Reader@Example.com');
		const b = credentialBucketKey('login', '4:c0000201', 'reader@example.com');
		const other = credentialBucketKey('login', '4:c0000201', 'other@example.com');
		const elsewhere = credentialBucketKey('login', '4:c0000209', 'reader@example.com');
		expect(a).toBe(b);
		expect(a).not.toBe(other);
		expect(a).not.toBe(elsewhere);
		expect(a).not.toContain('reader');
		expect(a).toMatch(/^limits:login:4:c0000201:[0-9a-f]{16}$/);
		expect(credentialBucketKey('admin-login', '6:0:64', 'owner@example.com')).toMatch(
			/^limits:admin-login:6:0:64:[0-9a-f]{16}$/
		);
	});
});

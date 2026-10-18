import { describe, expect, it, vi } from 'vitest';
import { decodeHmacKey, hashEmail, keyedHasher } from './email-hash';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('email hashing', () => {
	it('accepts exactly 32 bytes of base64', () => {
		expect(decodeHmacKey(KEY)).toEqual(Buffer.alloc(32, 7));
		expect(decodeHmacKey('')).toBeNull();
		expect(decodeHmacKey(undefined)).toBeNull();
		expect(decodeHmacKey(Buffer.alloc(16, 1).toString('base64'))).toBeNull();
		expect(decodeHmacKey('not base64!')).toBeNull();
	});

	it('is deterministic and key-dependent', () => {
		const key = decodeHmacKey(KEY)!;
		const other = decodeHmacKey(Buffer.alloc(32, 9).toString('base64'))!;
		const one = hashEmail('reader@example.com', key);
		expect(one).toMatch(/^[0-9a-f]{64}$/);
		expect(hashEmail('reader@example.com', key)).toBe(one);
		expect(hashEmail('reader@example.com', other)).not.toBe(one);
		expect(hashEmail('other@example.com', key)).not.toBe(one);
	});

	it('degrades explicitly when the key is missing', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(keyedHasher('SUBSCRIBE_HMAC_KEY', '')).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('SUBSCRIBE_HMAC_KEY'));
		warn.mockRestore();
	});
});

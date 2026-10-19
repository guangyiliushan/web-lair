import { describe, expect, it, vi } from 'vitest';
import { decodeHmacKey, hashEmail, keyedHasher } from './email-hash';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('email hashing', () => {
	it('accepts padded, unpadded and URL-safe 32-byte keys', () => {
		const padded = Buffer.alloc(32, 7).toString('base64');
		const unpadded = padded.replace(/=+$/, '');
		const urlsafe = padded.replace(/\+/g, '-').replace(/\//g, '_');
		expect(decodeHmacKey(padded)).toEqual(Buffer.alloc(32, 7));
		expect(decodeHmacKey(unpadded)).toEqual(Buffer.alloc(32, 7));
		expect(decodeHmacKey(urlsafe)).toEqual(Buffer.alloc(32, 7));
	});

	it('accepts exactly 32 bytes of base64', () => {
		expect(decodeHmacKey(KEY)).toEqual(Buffer.alloc(32, 7));
		expect(decodeHmacKey('')).toBeNull();
		expect(decodeHmacKey(undefined)).toBeNull();
		expect(decodeHmacKey(Buffer.alloc(16, 1).toString('base64'))).toBeNull();
		expect(decodeHmacKey('not base64!')).toBeNull();
		// Old lenient decode skipped '!' and still produced 32 bytes; the
		// explicit alphabet check must reject it.
		expect(decodeHmacKey(KEY.slice(0, 43) + '!')).toBeNull();
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

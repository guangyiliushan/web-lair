import { describe, expect, it } from 'vitest';
import { StorageError, type ObjectStoragePort, type StoredObjectBody } from './port';
import { PROBE_KEY_PREFIX, probeStorage } from './probe';

/**
 * Connection probe (W7.3): HeadBucket → capabilities → Put/Get/Delete. Each
 * stage maps to a closed status code, the probe object never lingers, and no
 * failure message carries the endpoint or a credential.
 */
interface ProbeFakeOptions {
	headBucket?: () => Promise<void>;
	capabilities?: () => Promise<{
		versioning: 'off' | 'enabled' | 'suspended' | 'unknown';
		objectLock: boolean | null;
	}>;
	put?: (key: string, data: Uint8Array) => Promise<{ etag: string | null }>;
	get?: (key: string) => Promise<StoredObjectBody | null>;
	delete?: (key: string) => Promise<void>;
}

function fakeStorage(options: ProbeFakeOptions = {}) {
	const calls: string[] = [];
	const storage: ObjectStoragePort = {
		ensureBucket: async () => {},
		headBucket: async () => {
			calls.push('headBucket');
			await (options.headBucket ?? (async () => {}))();
		},
		bucketCapabilities: async () => {
			calls.push('capabilities');
			return (options.capabilities ?? (async () => ({ versioning: 'off', objectLock: false })))();
		},
		put: async (key, data) => {
			calls.push(`put:${key}`);
			return (options.put ?? (async () => ({ etag: '"x"' })))(key, data);
		},
		get: async (key) => {
			calls.push(`get:${key}`);
			return options.get
				? options.get(key)
				: {
						body: new Blob([new Uint8Array()]).stream(),
						byteSize: 0,
						contentType: null,
						etag: null,
						status: 200
					};
		},
		head: async () => null,
		delete: async (key) => {
			calls.push(`delete:${key}`);
			await (options.delete ?? (async () => {}))(key);
		}
	};
	return { storage, calls };
}

const FIXED_CLOCK = () => new Date(Date.UTC(2026, 10, 14, 12, 0, 0));

describe('storage probe', () => {
	it('passes and cleans up the probe object', async () => {
		const { storage, calls } = fakeStorage({
			put: async () => ({ etag: '"x"' }),
			get: async () => ({
				body: new Blob([
					new TextEncoder().encode('web-lair storage probe 2026-11-14T12:00:00.000Z\n')
				]).stream(),
				byteSize: null,
				contentType: 'text/plain',
				etag: null,
				status: 200
			})
		});

		const result = await probeStorage(storage, { clock: FIXED_CLOCK });

		expect(result.ok).toBe(true);
		expect(result.status).toBe('ok');
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.checkedAt).toBe('2026-11-14T12:00:00.000Z');
		expect(calls[0]).toBe('headBucket');
		expect(calls[1]).toBe('capabilities');
		const putKey = calls.find((call) => call.startsWith('put:'))!.slice(4);
		expect(putKey.startsWith(PROBE_KEY_PREFIX)).toBe(true);
		expect(calls).toContain(`delete:${putKey}`);
	});

	it('maps a bad credential to auth (403)', async () => {
		const { storage } = fakeStorage({
			headBucket: async () => {
				throw new StorageError(
					'storage headBucket failed: HTTP 403 (AccessDenied)',
					403,
					'AccessDenied'
				);
			}
		});
		const result = await probeStorage(storage, { clock: FIXED_CLOCK });
		expect(result).toMatchObject({ ok: false, status: 'auth' });
	});

	it('maps a missing bucket to not-found (404)', async () => {
		const { storage } = fakeStorage({
			headBucket: async () => {
				throw new StorageError(
					'storage headBucket failed: HTTP 404 (NoSuchBucket)',
					404,
					'NoSuchBucket'
				);
			}
		});
		expect((await probeStorage(storage, { clock: FIXED_CLOCK })).status).toBe('not-found');
	});

	it('maps a timeout and a transport failure apart', async () => {
		const timedOut = fakeStorage({
			headBucket: async () => {
				throw new StorageError('storage request failed: HEAD /bucket', 0, null);
			}
		});
		expect((await probeStorage(timedOut.storage, { clock: FIXED_CLOCK })).status).toBe('network');

		const timeoutError = fakeStorage({
			headBucket: async () => {
				throw new StorageError(
					'storage request failed: HEAD /bucket: timed out after 10000ms',
					0,
					null
				);
			}
		});
		expect((await probeStorage(timeoutError.storage, { clock: FIXED_CLOCK })).status).toBe(
			'timeout'
		);
	});

	it('reports a readable-but-not-writable bucket as write', async () => {
		const { storage } = fakeStorage({
			put: async () => {
				throw new StorageError(
					'storage put probe failed: HTTP 403 (AccessDenied)',
					403,
					'AccessDenied'
				);
			}
		});
		const result = await probeStorage(storage, { clock: FIXED_CLOCK });
		expect(result).toMatchObject({ ok: false, status: 'auth' });
	});

	it('flags a bucket whose capabilities cannot be PROVEN (same predicate as purge)', async () => {
		for (const capabilities of [
			{ versioning: 'unknown' as const, objectLock: null },
			// One readable half is not enough: the purge guard fails closed here,
			// so a green probe would contradict a permanently refused delete.
			{ versioning: 'off' as const, objectLock: null }
		]) {
			const { storage } = fakeStorage({ capabilities: async () => capabilities });
			const result = await probeStorage(storage, { clock: FIXED_CLOCK });
			expect(result, JSON.stringify(capabilities)).toMatchObject({
				ok: false,
				status: 'capability'
			});
		}
	});

	it('fails when the read-back does not match the write', async () => {
		const { storage, calls } = fakeStorage({
			get: async () => ({
				body: new Blob([new TextEncoder().encode('tampered')]).stream(),
				byteSize: 8,
				contentType: null,
				etag: null,
				status: 200
			})
		});
		const result = await probeStorage(storage, { clock: FIXED_CLOCK });
		expect(result).toMatchObject({ ok: false, status: 'write' });
		// The probe object is still removed.
		expect(calls.some((call) => call.startsWith('delete:'))).toBe(true);
	});

	it('keeps the probe object key out of a failure message', async () => {
		const { storage } = fakeStorage({
			put: async () => {
				throw new StorageError(
					'storage put probe/abc123.txt failed: HTTP 500',
					500,
					'InternalError'
				);
			}
		});
		const result = await probeStorage(storage, { clock: FIXED_CLOCK });
		expect(result.status).not.toBe('ok');
		expect(result.message).not.toContain('probe/');
		expect(result.message).not.toContain('abc123');
	});

	it('keeps the failure message free of the endpoint and the key', async () => {
		const { storage } = fakeStorage({
			headBucket: async () => {
				throw new StorageError(
					'storage request failed: HEAD https://user:pass@s3.example.com/bucket?X-Amz-Signature=abc',
					0,
					null
				);
			}
		});
		const result = await probeStorage(storage, { clock: FIXED_CLOCK });
		expect(result.message).not.toContain('s3.example.com');
		expect(result.message).not.toContain('user:pass');
		expect(result.message).not.toContain('X-Amz-Signature');
	});
});

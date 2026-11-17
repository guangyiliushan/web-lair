import { describe, expect, it, vi } from 'vitest';
import { StorageError, type ObjectStoragePort, type StoredObjectBody } from './port';
import { copyObjects, enumerateMigrationObjects, planMigration } from './migrate';
import { sha256Hex } from './signature';

/**
 * Migration engine: enumeration adds variants, the plan reports what is
 * already on the target, and the copy proves itself by hashing both ends.
 * Resumption must never rewrite bytes that are already correct.
 */
const CANONICAL = 'ab/' + 'ab'.padEnd(64, '0') + '.webp';
const HASH = CANONICAL.slice(3, 67);
const PAYLOAD = new TextEncoder().encode('canonical bytes');

function bodyOf(bytes: Uint8Array): StoredObjectBody {
	// Copy into a plain ArrayBuffer: TS 5.7 distinguishes ArrayBufferLike-backed
	// views, and Blob only accepts the ArrayBuffer-backed form.
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return {
		body: new Blob([copy.buffer]).stream(),
		byteSize: bytes.byteLength,
		contentType: 'image/webp',
		etag: null,
		status: 200
	};
}

interface FakeBucket {
	objects: Map<string, Uint8Array>;
	put: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	port(): ObjectStoragePort;
}

function bucket(initial: Record<string, Uint8Array> = {}): FakeBucket {
	const objects = new Map(Object.entries(initial));
	const put = vi.fn(async (key: string, data: Uint8Array) => {
		objects.set(key, data);
		return { etag: null };
	});
	const storageImpl = {
		objects,
		put,
		delete: vi.fn(async () => {}),
		port(): ObjectStoragePort {
			return {
				ensureBucket: async () => {},
				headBucket: async () => {},
				bucketCapabilities: async () => ({ versioning: 'off', objectLock: false }),
				put,
				get: async (key: string) => {
					const bytes = objects.get(key);
					return bytes ? bodyOf(bytes) : null;
				},
				head: async (key: string) =>
					objects.has(key)
						? {
								key,
								byteSize: objects.get(key)!.byteLength,
								contentType: 'image/webp',
								etag: null
							}
						: null,
				delete: async (key: string) => {
					objects.delete(key);
				}
			};
		}
	};
	return storageImpl;
}

describe('migration enumeration', () => {
	it('adds every derived variant to a canonical row', () => {
		const objects = enumerateMigrationObjects([
			{ objectKey: CANONICAL, contentHash: HASH, byteSize: PAYLOAD.byteLength }
		]);
		expect(objects.map((object) => object.key)).toEqual([
			CANONICAL,
			`${CANONICAL}@thumb`,
			`${CANONICAL}@grid`,
			`${CANONICAL}@preview`,
			`${CANONICAL}@full`
		]);
		expect(objects[0]).toMatchObject({
			kind: 'canonical',
			expectedHash: HASH,
			expectedBytes: PAYLOAD.byteLength
		});
		expect(objects[1]).toMatchObject({ kind: 'variant', expectedHash: null });
	});
});

describe('migration plan', () => {
	it('separates a missing canonical object from missing variants', async () => {
		const source = bucket({});
		const target = bucket({ [`${CANONICAL}@thumb`]: PAYLOAD });
		const objects = enumerateMigrationObjects([
			{ objectKey: CANONICAL, contentHash: HASH, byteSize: PAYLOAD.byteLength }
		]);

		const plan = await planMigration(objects, {
			source: source.port(),
			target: target.port()
		});

		// The canonical object is absent → fatal; variants are merely expected.
		expect(plan.missingOnSource).toEqual([CANONICAL]);
		expect(plan.missingVariants).toBe(4);
		expect(plan.existingOnTarget).toBe(1);
		expect(plan.pending).toBe(4);
		expect(plan.total).toBe(5);
		expect(plan.canonical).toBe(1);
		expect(plan.variants).toBe(4);
	});

	it('stays DB-only when the source check is disabled', async () => {
		const source = bucket({});
		const target = bucket({});
		const sourcePort = source.port();
		const headSpy = vi.spyOn(sourcePort, 'head');
		const objects = enumerateMigrationObjects([
			{ objectKey: CANONICAL, contentHash: HASH, byteSize: 3 }
		]);

		await planMigration(
			objects,
			{ source: sourcePort, target: target.port() },
			{ checkSource: false }
		);

		expect(headSpy).not.toHaveBeenCalled();
	});
});

describe('migration copy', () => {
	it('copies, verifies both ends and re-runs as a verify-only pass', async () => {
		const source = bucket({ [CANONICAL]: PAYLOAD });
		const target = bucket({});
		const objects = enumerateMigrationObjects([
			{ objectKey: CANONICAL, contentHash: sha256Hex(PAYLOAD), byteSize: PAYLOAD.byteLength }
		]);
		// Only the canonical object exists on the source; the four variants are
		// legitimately absent, so the plan lists them as missingVariants and the
		// copy skips them — a missing VARIANT is never a failure (only a missing
		// canonical object is).
		const first = await copyObjects(objects, {
			source: source.port(),
			target: target.port()
		});

		expect(first.copied).toBe(1);
		expect(first.verified).toBe(1);
		expect(first.failed).toEqual([]);
		expect(first.missingVariants).toBe(4);
		expect(Array.from(target.objects.keys())).toEqual([CANONICAL]);

		// Second run: the canonical object is already correct → verified, not
		// rewritten (resume semantics).
		const putCalls = target.put.mock.calls.length;
		const second = await copyObjects(objects, {
			source: source.port(),
			target: target.port()
		});
		expect(target.put.mock.calls.length).toBe(putCalls);
		expect(second.skipped).toBe(1);
		expect(second.verified).toBe(1);
	});

	it('refuses a canonical object whose bytes do not match its hash', async () => {
		const tampered = new TextEncoder().encode('not the hashed bytes');
		const source = bucket({ [CANONICAL]: tampered });
		const target = bucket({});
		const objects = enumerateMigrationObjects([
			{ objectKey: CANONICAL, contentHash: sha256Hex(PAYLOAD), byteSize: PAYLOAD.byteLength }
		]);

		const outcome = await copyObjects(objects, {
			source: source.port(),
			target: target.port()
		});

		expect(outcome.failed[0]).toEqual({ key: CANONICAL, reason: 'source-hash-mismatch' });
		expect(outcome.copied).toBe(0);
		expect(target.objects.size).toBe(0);
	});

	it('reports a read failure on the source as missing', async () => {
		const port: ObjectStoragePort = {
			ensureBucket: async () => {},
			headBucket: async () => {},
			bucketCapabilities: async () => ({ versioning: 'off', objectLock: false }),
			put: async () => ({ etag: null }),
			get: async () => {
				throw new StorageError('storage get failed: HTTP 500', 500, 'InternalError');
			},
			head: async () => null,
			delete: async () => {}
		};
		const outcome = await copyObjects(
			[{ key: CANONICAL, expectedHash: HASH, expectedBytes: 3, kind: 'canonical' }],
			{ source: port, target: bucket({}).port() }
		);
		expect(outcome.failed).toEqual([{ key: CANONICAL, reason: 'missing-source' }]);
	});

	it('reports a missing read-back after a successful write (no silent verified)', async () => {
		const source = bucket({ [CANONICAL]: PAYLOAD });
		const target = bucket({});
		// Write succeeds, but the object is gone when verification reads it.
		const port = target.port();
		const flaky: typeof port = {
			...port,
			get: async () => null
		};

		const outcome = await copyObjects(
			[
				{
					key: CANONICAL,
					expectedHash: sha256Hex(PAYLOAD),
					expectedBytes: PAYLOAD.byteLength,
					kind: 'canonical'
				}
			],
			{ source: source.port(), target: flaky }
		);

		expect(outcome.copied).toBe(1);
		expect(outcome.verified).toBe(0);
		expect(outcome.failed).toEqual([{ key: CANONICAL, reason: 'read-back-missing' }]);
	});

	it('reports a read-back mismatch when the target object differs', async () => {
		const source = bucket({ [CANONICAL]: PAYLOAD });
		const target = bucket({});
		const port = target.port();
		const flaky: typeof port = {
			...port,
			get: async () => bodyOf(new TextEncoder().encode('tampered bytes')),
			put: port.put
		};

		const outcome = await copyObjects(
			[
				{
					key: CANONICAL,
					expectedHash: sha256Hex(PAYLOAD),
					expectedBytes: PAYLOAD.byteLength,
					kind: 'canonical'
				}
			],
			{ source: source.port(), target: flaky }
		);

		expect(outcome.copied).toBe(1);
		expect(outcome.verified).toBe(0);
		expect(outcome.failed).toEqual([{ key: CANONICAL, reason: 'read-back-mismatch' }]);
	});

	it('reports a target write failure without claiming verification', async () => {
		const source = bucket({ [CANONICAL]: PAYLOAD });
		const target = bucket({});
		target.put.mockImplementation(async () => {
			throw new StorageError('storage put failed: HTTP 500', 500, 'InternalError');
		});

		const outcome = await copyObjects(
			[
				{
					key: CANONICAL,
					expectedHash: sha256Hex(PAYLOAD),
					expectedBytes: PAYLOAD.byteLength,
					kind: 'canonical'
				}
			],
			{ source: source.port(), target: target.port() }
		);

		expect(outcome.failed).toEqual([{ key: CANONICAL, reason: 'write-failed' }]);
		expect(outcome.verified).toBe(0);
	});

	it('rewrites a target object whose bytes differ but whose size matches', async () => {
		const other = new TextEncoder().encode('different text!');
		const source = bucket({ [CANONICAL]: PAYLOAD });
		const target = bucket({ [CANONICAL]: other });
		expect(other.byteLength).toBe(PAYLOAD.byteLength);

		const outcome = await copyObjects(
			[
				{
					key: CANONICAL,
					expectedHash: sha256Hex(PAYLOAD),
					expectedBytes: PAYLOAD.byteLength,
					kind: 'canonical'
				}
			],
			{ source: source.port(), target: target.port() }
		);

		expect(outcome.copied).toBe(1);
		expect(outcome.verified).toBe(1);
		expect(Array.from(target.objects.get(CANONICAL)!)).toEqual(Array.from(PAYLOAD));
	});
});

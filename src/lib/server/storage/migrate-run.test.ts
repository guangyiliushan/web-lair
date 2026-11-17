import { describe, expect, it } from 'vitest';
import { enumerateMigrationObjects } from './migrate';
import { runCopyPhase } from './migrate-run';
import type { ObjectStoragePort, StoredObjectBody } from './port';
import type { StorageMigrationState } from './provider';
import { sha256Hex } from './signature';

/**
 * Copy-phase orchestration: the heartbeat must read mutable counters
 * declared OUTSIDE the copy call (reading the call's own result is a
 * temporal-dead-zone error that froze uploads with nothing copied), missing
 * variants must not fail the run, and a missing canonical object must.
 */
function bodyOf(bytes: Uint8Array): StoredObjectBody {
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

function bucket(initial: Record<string, Uint8Array> = {}) {
	const objects = new Map(Object.entries(initial));
	const port: ObjectStoragePort = {
		ensureBucket: async () => {},
		headBucket: async () => {},
		bucketCapabilities: async () => ({ versioning: 'off', objectLock: false }),
		put: async (key, data) => {
			objects.set(key, data);
			return { etag: null };
		},
		get: async (key) => {
			const bytes = objects.get(key);
			return bytes ? bodyOf(bytes) : null;
		},
		head: async (key) => {
			const bytes = objects.get(key);
			return bytes
				? { key, byteSize: bytes.byteLength, contentType: 'image/webp', etag: null }
				: null;
		},
		delete: async (key) => {
			objects.delete(key);
		}
	};
	return { port, objects };
}

function rows(bodies: Uint8Array[]) {
	return enumerateMigrationObjects(
		bodies.map((bytes) => {
			const hash = sha256Hex(bytes);
			return {
				objectKey: `${hash.slice(0, 2)}/${hash}.webp`,
				contentHash: hash,
				byteSize: bytes.byteLength
			};
		})
	);
}

const BODY_A = new TextEncoder().encode('aaaa');
const BODY_B = new TextEncoder().encode('bbbb');

describe('runCopyPhase', () => {
	it('persists copying → copied and never fails on absent variants', async () => {
		const hash = sha256Hex(BODY_A);
		const source = bucket({ [`${hash.slice(0, 2)}/${hash}.webp`]: BODY_A });
		const target = bucket({});
		const states: StorageMigrationState[] = [];

		const result = await runCopyPhase({
			objects: rows([BODY_A]),
			source: source.port,
			target: target.port,
			runId: 'run-1',
			sourceFingerprint: 'source',
			targetFingerprint: 'target',
			plan: { total: 5, bytes: 4 },
			saveState: async (state) => {
				states.push(structuredClone(state));
			},
			now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, 0))
		});

		// The heartbeat runs before the first object (index 1), so there are at
		// least three writes: opening, heartbeat, final.
		expect(states.length).toBeGreaterThanOrEqual(3);
		expect(states[0].state).toBe('copying');
		expect(states[0].total).toBe(5);
		expect(result.state.state).toBe('copied');
		expect(result.outcome.copied).toBe(1);
		expect(result.outcome.failed).toEqual([]);
		expect(result.outcome.missingVariants).toBe(4);
		// total counts objects that must exist, so verified === total holds.
		expect(result.present).toBe(1);
		expect(result.state.verified).toBe(result.state.total);
		expect(result.state.failed).toBe(0);
	});

	it('fails the run when a canonical object is missing from the source', async () => {
		const source = bucket({});
		const target = bucket({});
		const states: StorageMigrationState[] = [];

		const result = await runCopyPhase({
			objects: rows([BODY_A]),
			source: source.port,
			target: target.port,
			runId: 'run-2',
			sourceFingerprint: 'source',
			targetFingerprint: 'target',
			plan: { total: 1, bytes: 0 },
			saveState: async (state) => {
				states.push(structuredClone(state));
			}
		});

		expect(result.state.state).toBe('failed');
		expect(result.state.failed).toBe(1);
		expect(result.state.error).toContain('1');
		expect(result.outcome.failed[0]).toMatchObject({ reason: 'missing-source' });
	});

	it('heartbeats at the configured cadence and reports progress', async () => {
		const bodies = [BODY_A, BODY_B].map((bytes) => {
			const hash = sha256Hex(bytes);
			return { hash, bytes, key: `${hash.slice(0, 2)}/${hash}.webp` };
		});
		const source = bucket(Object.fromEntries(bodies.map((b) => [b.key, b.bytes])));
		const target = bucket({});
		const states: StorageMigrationState[] = [];
		const progress: string[] = [];

		const objects = enumerateMigrationObjects(
			bodies.map((b) => ({
				objectKey: b.key,
				contentHash: sha256Hex(b.bytes),
				byteSize: b.bytes.byteLength
			}))
		);

		await runCopyPhase({
			objects,
			source: source.port,
			target: target.port,
			runId: 'run-3',
			sourceFingerprint: 'source',
			targetFingerprint: 'target',
			plan: { total: objects.length, bytes: 8 },
			heartbeatEvery: 2,
			saveState: async (state) => {
				states.push(structuredClone(state));
			},
			onProgress: (entry) => progress.push(entry.outcome)
		});

		// 2 canonical + 8 variants; heartbeat at index 1, 3, 5, 7, 9 → plus the
		// opening and final rows.
		expect(states.length).toBeGreaterThanOrEqual(6);
		expect(states.some((state) => state.state === 'copying' && state.copied > 0)).toBe(true);
		expect(progress.filter((outcome) => outcome === 'copied')).toHaveLength(2);
	});
});

import { describe, expect, it, vi } from 'vitest';
import {
	ActivationError,
	activateSavedProvider,
	activationIdentity,
	rollbackToPreviousProvider,
	type ActivationStore
} from './activation';
import {
	DEFAULT_PROVIDER_CONFIG,
	DEFAULT_STORAGE_MIGRATION,
	providerFingerprint,
	type StorageActive,
	type StorageMigrationState,
	type StorageProviderConfig
} from './provider';

/**
 * Activation guards (W7.4/Q13 + W7.5/Q8): a cutover needs a COMPLETE copy of a
 * NEW addressing target, the bucket must answer HEAD and a provable
 * versioning/object-lock verdict, a deleteMode-only change is a legal
 * activation without a copy, and rollback refuses when post-cutover objects
 * would be stranded.
 */
const LOCAL = DEFAULT_PROVIDER_CONFIG;
const EXTERNAL: StorageProviderConfig = {
	driver: 's3',
	providerType: 'minio',
	endpoint: 'https://s3.example.com',
	region: 'us-east-1',
	bucket: 'lair-media',
	forcePathStyle: true,
	publicBaseUrl: null,
	deleteMode: 'hard'
};

function makeStore(overrides: {
	active?: StorageActive;
	provider?: StorageProviderConfig;
	migration?: StorageMigrationState;
	files?: number;
	filesSince?: number;
	capabilities?: {
		versioning: 'off' | 'enabled' | 'suspended' | 'unknown';
		objectLock: boolean | null;
	};
	headBucketFails?: boolean;
}) {
	const state = {
		active: overrides.active ?? {
			config: LOCAL,
			previous: null,
			activatedAt: null
		},
		provider: overrides.provider ?? EXTERNAL,
		migration: overrides.migration ?? { ...DEFAULT_STORAGE_MIGRATION },
		files: overrides.files ?? 0
	};
	const audit = vi.fn(async () => {});
	const applyActivation = vi.fn(async (active: StorageActive, migration: StorageMigrationState) => {
		state.active = active;
		state.migration = migration;
	});
	const store: ActivationStore = {
		getActive: async () => state.active,
		getProvider: async () => state.provider,
		getMigration: async () => state.migration,
		applyActivation,
		countFiles: async () => state.files,
		countFilesSince: async () => overrides.filesSince ?? 0,
		headBucket: async () => {
			if (overrides.headBucketFails) throw new Error('HTTP 404 NoSuchBucket');
		},
		capabilities: async () => overrides.capabilities ?? { versioning: 'off', objectLock: false },
		audit,
		now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0))
	};
	return { store, state, audit, applyActivation };
}

function completeCopy(target: StorageProviderConfig, total = 5): StorageMigrationState {
	return {
		...DEFAULT_STORAGE_MIGRATION,
		state: 'copied',
		id: 'run-1',
		startedAt: '2026-11-14T08:00:00.000Z',
		finishedAt: '2026-11-14T08:10:00.000Z',
		targetFingerprint: providerFingerprint(target),
		total,
		verified: total,
		copied: total,
		bytes: 120
	};
}

describe('activation identity', () => {
	it('treats a deleteMode-only change as a different activation of the same bucket', () => {
		const logical = { ...EXTERNAL, deleteMode: 'logical' as const };
		expect(providerFingerprint(logical)).toBe(providerFingerprint(EXTERNAL));
		expect(activationIdentity(logical)).not.toBe(activationIdentity(EXTERNAL));
	});
});

describe('activateSavedProvider', () => {
	it('activates directly when the registry is empty and remembers the previous config', async () => {
		const { store, state, audit, applyActivation } = makeStore({ files: 0 });

		const result = await activateSavedProvider(store);

		expect(result.files).toBe(0);
		expect(state.active.config).toEqual(EXTERNAL);
		expect(state.active.previous).toEqual(LOCAL);
		expect(state.active.activatedAt).toBe('2026-11-14T09:00:00.000Z');
		expect(state.migration.state).toBe('cutover');
		// One transactional write, not two independent upserts.
		expect(applyActivation).toHaveBeenCalledTimes(1);
		expect(audit).toHaveBeenCalledWith(
			'storage.activate',
			expect.objectContaining({ action: 'activate', delete_mode: 'hard' })
		);
	});

	it('refuses to cut over a NEW target with media on disk but no completed copy', async () => {
		const { store, state } = makeStore({ files: 3 });
		await expect(activateSavedProvider(store)).rejects.toMatchObject({
			name: 'ActivationError',
			code: 'migration-required'
		});
		expect(state.active.config).toEqual(LOCAL);
	});

	it('refuses a copy that belongs to a different target', async () => {
		const other = { ...EXTERNAL, bucket: 'another-bucket' };
		const { store } = makeStore({ files: 3, migration: completeCopy(other) });
		await expect(activateSavedProvider(store)).rejects.toMatchObject({
			code: 'migration-incomplete'
		});
	});

	it('refuses a copy with failed objects, and separately one with unverified objects', async () => {
		const failedOnly = { ...completeCopy(EXTERNAL), failed: 1, verified: 5 };
		await expect(
			activateSavedProvider(makeStore({ files: 3, migration: failedOnly }).store)
		).rejects.toMatchObject({ code: 'migration-incomplete' });

		const unverified = { ...completeCopy(EXTERNAL), failed: 0, verified: 4 };
		await expect(
			activateSavedProvider(makeStore({ files: 3, migration: unverified }).store)
		).rejects.toMatchObject({ code: 'migration-incomplete' });
	});

	it('refuses when the registry has media but the plan recorded zero objects', async () => {
		const emptyPlan = { ...completeCopy(EXTERNAL), total: 0, verified: 0 };
		await expect(
			activateSavedProvider(makeStore({ files: 3, migration: emptyPlan }).store)
		).rejects.toMatchObject({ code: 'migration-incomplete' });
	});

	it('accepts a complete copy of the exact target', async () => {
		const { store, state } = makeStore({ files: 3, migration: completeCopy(EXTERNAL) });
		const result = await activateSavedProvider(store);
		expect(result.files).toBe(3);
		expect(state.active.config).toEqual(EXTERNAL);
	});

	it('allows a deleteMode-only change without requiring a copy', async () => {
		const logical = { ...EXTERNAL, deleteMode: 'logical' as const };
		const { store, state } = makeStore({
			files: 7,
			active: { config: EXTERNAL, previous: LOCAL, activatedAt: '2026-11-01T00:00:00.000Z' },
			provider: logical,
			migration: { ...DEFAULT_STORAGE_MIGRATION },
			capabilities: { versioning: 'enabled', objectLock: false }
		});

		const result = await activateSavedProvider(store);

		expect(result.to.deleteMode).toBe('logical');
		expect(state.active.config.deleteMode).toBe('logical');
	});

	it('refuses a target bucket that does not answer HEAD', async () => {
		await expect(
			activateSavedProvider(makeStore({ files: 0, headBucketFails: true }).store)
		).rejects.toMatchObject({ code: 'target-unavailable' });
	});

	it('fails closed when the capability verdict is not provable', async () => {
		await expect(
			activateSavedProvider(
				makeStore({
					files: 0,
					capabilities: { versioning: 'off', objectLock: null }
				}).store
			)
		).rejects.toMatchObject({ code: 'capability-unknown' });
		await expect(
			activateSavedProvider(
				makeStore({
					files: 0,
					capabilities: { versioning: 'unknown', objectLock: false }
				}).store
			)
		).rejects.toMatchObject({ code: 'capability-unknown' });
	});

	it('refuses a versioned or object-locked bucket unless logical delete was chosen', async () => {
		await expect(
			activateSavedProvider(
				makeStore({ files: 0, capabilities: { versioning: 'enabled', objectLock: false } }).store
			)
		).rejects.toMatchObject({ code: 'versioning-blocked' });
		await expect(
			activateSavedProvider(
				makeStore({ files: 0, capabilities: { versioning: 'off', objectLock: true } }).store
			)
		).rejects.toMatchObject({ code: 'versioning-blocked' });
	});

	it('allows a versioned bucket in logical delete mode', async () => {
		const logical = { ...EXTERNAL, deleteMode: 'logical' as const };
		const { store, state } = makeStore({
			files: 0,
			provider: logical,
			capabilities: { versioning: 'enabled', objectLock: false }
		});

		await activateSavedProvider(store);

		expect(state.active.config.deleteMode).toBe('logical');
		expect(state.migration.state).toBe('cutover');
	});

	it('refuses to activate the config that is already live', async () => {
		await expect(
			activateSavedProvider(makeStore({ provider: LOCAL, files: 0 }).store)
		).rejects.toMatchObject({ code: 'same-provider' });
	});
});

describe('rollbackToPreviousProvider', () => {
	const active: StorageActive = {
		config: EXTERNAL,
		previous: LOCAL,
		activatedAt: '2026-11-14T09:00:00.000Z'
	};

	it('swaps back to the previous config and marks the state', async () => {
		const { store, state, audit, applyActivation } = makeStore({ active, provider: EXTERNAL });

		const result = await rollbackToPreviousProvider(store);

		expect(result.to).toEqual(LOCAL);
		expect(state.active.config).toEqual(LOCAL);
		expect(state.active.previous).toEqual(EXTERNAL);
		expect(state.migration.state).toBe('rolled-back');
		expect(applyActivation).toHaveBeenCalledTimes(1);
		expect(audit).toHaveBeenCalledWith(
			'storage.activate',
			expect.objectContaining({ action: 'rollback' })
		);
	});

	it('refuses when objects were uploaded after the cutover', async () => {
		const { store, state } = makeStore({ active, filesSince: 2 });

		await expect(rollbackToPreviousProvider(store)).rejects.toMatchObject({
			code: 'post-cutover-objects'
		});
		expect(state.active.config).toEqual(EXTERNAL);
	});

	it('refuses when there is no previous provider', async () => {
		await expect(rollbackToPreviousProvider(makeStore({}).store)).rejects.toMatchObject({
			name: 'ActivationError',
			code: 'no-previous'
		});
	});

	it('exposes the error class for callers mapping exit codes', () => {
		expect(new ActivationError('no-previous', 'x')).toMatchObject({
			name: 'ActivationError',
			code: 'no-previous',
			message: 'x'
		});
	});
});

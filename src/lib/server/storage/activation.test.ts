import { describe, expect, it, vi } from 'vitest';
import {
	ActivationError,
	activateSavedProvider,
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
 * Activation guards (W7.4/Q13 + W7.5/Q8): a cutover needs a COMPLETE copy of
 * exactly this target, and a bucket that cannot hard-delete is refused even
 * when the copy succeeded. Rollback swaps back.
 */
const LOCAL = DEFAULT_PROVIDER_CONFIG;
const EXTERNAL: StorageProviderConfig = {
	driver: 's3',
	providerType: 'minio',
	endpoint: 'https://s3.example.com',
	region: 'us-east-1',
	bucket: 'lair-media',
	forcePathStyle: true,
	publicBaseUrl: null
};

function makeStore(overrides: {
	active?: StorageActive;
	provider?: StorageProviderConfig;
	migration?: StorageMigrationState;
	files?: number;
	capabilities?: { versioning: string; objectLock: boolean | null } | null;
}) {
	const state = {
		active: overrides.active ?? {
			config: LOCAL,
			previous: null,
			activatedAt: null,
			activatedBy: null
		},
		provider: overrides.provider ?? EXTERNAL,
		migration: overrides.migration ?? { ...DEFAULT_STORAGE_MIGRATION },
		files: overrides.files ?? 0
	};
	const audit = vi.fn(async () => {});
	const store: ActivationStore = {
		getActive: async () => state.active,
		getProvider: async () => state.provider,
		getMigration: async () => state.migration,
		setActive: async (value) => {
			state.active = value;
		},
		setMigration: async (value) => {
			state.migration = value;
		},
		countFiles: async () => state.files,
		capabilities: async () =>
			overrides.capabilities === undefined
				? { versioning: 'off', objectLock: false }
				: overrides.capabilities,
		audit,
		now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0))
	};
	return { store, state, audit };
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

describe('activateSavedProvider', () => {
	it('activates directly when the registry is empty and remembers the previous config', async () => {
		const { store, state, audit } = makeStore({ files: 0 });

		const result = await activateSavedProvider(store);

		expect(result.files).toBe(0);
		expect(state.active.config).toEqual(EXTERNAL);
		expect(state.active.previous).toEqual(LOCAL);
		expect(state.active.activatedAt).toBe('2026-11-14T09:00:00.000Z');
		expect(state.migration.state).toBe('cutover');
		expect(audit).toHaveBeenCalledWith(
			'storage.activate',
			expect.objectContaining({ action: 'activate' })
		);
	});

	it('refuses to cut over with media on disk but no completed copy', async () => {
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

	it('refuses an incomplete copy (failed or unverified objects)', async () => {
		const partial = { ...completeCopy(EXTERNAL), failed: 1, verified: 4 };
		await expect(
			activateSavedProvider(makeStore({ files: 3, migration: partial }).store)
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

	it('fails closed when the bucket capabilities cannot be read', async () => {
		await expect(
			activateSavedProvider(makeStore({ files: 0, capabilities: null }).store)
		).rejects.toMatchObject({ code: 'capability-unknown' });
	});

	it('refuses a versioned or object-locked bucket (W7.5)', async () => {
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

	it('refuses to activate the config that is already live', async () => {
		await expect(
			activateSavedProvider(makeStore({ provider: LOCAL, files: 0 }).store)
		).rejects.toMatchObject({ code: 'same-provider' });
	});
});

describe('rollbackToPreviousProvider', () => {
	it('swaps back to the previous config and marks the state', async () => {
		const active: StorageActive = {
			config: EXTERNAL,
			previous: LOCAL,
			activatedAt: '2026-11-14T09:00:00.000Z',
			activatedBy: null
		};
		const { store, state, audit } = makeStore({ active, provider: EXTERNAL });

		const result = await rollbackToPreviousProvider(store);

		expect(result.to).toEqual(LOCAL);
		expect(state.active.config).toEqual(LOCAL);
		expect(state.active.previous).toEqual(EXTERNAL);
		expect(state.migration.state).toBe('rolled-back');
		expect(audit).toHaveBeenCalledWith(
			'storage.activate',
			expect.objectContaining({ action: 'rollback' })
		);
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

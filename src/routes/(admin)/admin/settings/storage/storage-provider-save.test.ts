import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storage control plane, route level: the tier gate decides who may write, Save
 * persists ONLY the candidate row (never `storage.active`), the schema rejects a
 * half-configured external provider before anything is written, and the purge form
 * keeps the 1-day floor.
 */
const state = vi.hoisted(() => ({
	// Widths are explicit: tests overwrite this with an external provider.
	provider: {
		driver: 'local' as 'local' | 's3',
		providerType: null as string | null,
		endpoint: null as string | null,
		region: 'us-east-1' as string,
		bucket: null as string | null,
		forcePathStyle: true as boolean,
		publicBaseUrl: null as string | null,
		deleteMode: 'hard' as 'hard' | 'logical'
	},
	active: {
		config: {
			driver: 'local' as const,
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		},
		previous: null as unknown,
		activatedAt: null as string | null
	},
	status: {
		lastTestAt: null as string | null,
		lastTestOk: null as boolean | null,
		lastError: null as string | null,
		bucketVersioning: null as string | null,
		objectLock: null as boolean | null,
		fingerprint: null as string | null
	},
	purge: { pendingDays: 7, detachedDays: 30 },
	fileCount: 0,
	credentialStatus: {
		source: 'missing' as 'db' | 'env' | 'missing' | 'unavailable',
		accessHint: null as string | null,
		secretHint: null as string | null,
		keyVersion: null as number | null,
		updatedAt: null as Date | null
	},
	credentialError: null as Error | null,
	savedCredentials: null as unknown,
	resolvedCredentials: null as {
		accessKeyId: string;
		secretAccessKey: string;
		source: 'db' | 'env';
	} | null,
	setOption: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
	recordActivity: vi.fn<(executor: unknown, input: unknown) => Promise<void>>(async () => {}),
	guard: vi.fn(async () => {}),
	probeResult: {
		ok: true,
		status: 'ok',
		message: '',
		latencyMs: 12,
		checkedAt: '2026-11-14T12:00:00.000Z',
		versioning: 'off',
		objectLock: false
	} as {
		ok: boolean;
		status: string;
		message: string;
		latencyMs: number;
		checkedAt: string;
		versioning: string | null;
		objectLock: boolean | null;
	}
}));

vi.mock('$lib/server/storage/probe', () => ({
	probeStorage: vi.fn(async () => state.probeResult)
}));

vi.mock('$lib/server/secrets/storage-credentials', () => {
	class StorageCredentialError extends Error {
		readonly reason: string;
		constructor(reason: string, message: string) {
			super(message);
			this.name = 'StorageCredentialError';
			this.reason = reason;
		}
	}
	return {
		StorageCredentialError,
		readStorageCredentialStatus: vi.fn(async () => state.credentialStatus),
		resolveStorageCredentials: vi.fn(async () => state.resolvedCredentials),
		saveStorageCredentials: vi.fn(async (_db: unknown, input: unknown) => {
			if (state.credentialError) throw state.credentialError;
			state.savedCredentials = input;
			return { keyVersion: 1 };
		}),
		clearStorageCredentials: vi.fn(async () => {})
	};
});

vi.mock('$env/dynamic/private', () => ({
	env: {
		RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
		RUSTFS_BUCKET: 'web-lair',
		RUSTFS_ACCESS_KEY: 'local-key',
		RUSTFS_SECRET_KEY: 'local-secret',
		STORAGE_S3_ACCESS_KEY: '',
		STORAGE_S3_SECRET_KEY: '',
		DATABASE_URL: 'postgres://root:db-password@db.example.com:5432/lair'
	}
}));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: state.guard }));
vi.mock('$lib/server/db', () => ({
	db: {
		$count: vi.fn(async () => state.fileCount),
		insert: vi.fn(),
		// Derive the ledger timestamp from the real journal: a hardcoded value
		// goes stale on every appended migration (merge lesson).
		execute: vi.fn(async () => {
			const { readFileSync } = await import('node:fs');
			const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
				entries: { when: number }[];
			};
			return [
				{ applied: journal.entries.length, latest: Math.max(...journal.entries.map((e) => e.when)) }
			];
		})
	}
}));
vi.mock('$lib/server/db/content', () => ({ files: { __table: 'files' } }));
vi.mock('$lib/server/audit', () => ({ recordActivity: state.recordActivity }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (key === 'storage.provider') return state.provider;
		if (key === 'storage.active') return state.active;
		if (key === 'storage.status') return state.status;
		if (key === 'media.purge') return state.purge;
		if (key === 'storage.migration') {
			return {
				state: 'idle',
				id: null,
				startedAt: null,
				finishedAt: null,
				cutoverAt: null,
				sourceFingerprint: null,
				targetFingerprint: null,
				total: 0,
				copied: 0,
				verified: 0,
				failed: 0,
				bytes: 0,
				error: null
			};
		}
		throw new Error(`unexpected option ${key}`);
	}),
	setOption: state.setOption,
	// The page validates media.purge through the registry schema; this stand-in
	// mirrors the real bounds (integer days, floor 1).
	validateOption: vi.fn((key: string, value: { pendingDays: number; detachedDays: number }) => {
		if (key !== 'media.purge') throw new Error(`unexpected option ${key}`);
		for (const days of [value.pendingDays, value.detachedDays]) {
			if (!Number.isInteger(days) || days < 1) throw new Error('invalid purge days');
		}
		return value;
	})
}));

import { actions, load } from './+page.server';

function makeEvent(fields: Record<string, string> = {}, role: 'owner' | 'admin' = 'owner') {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.append(key, value);
	return {
		request: new Request('http://x/admin/settings/storage?/saveProvider', {
			method: 'POST',
			body
		}),
		locals: { user: { id: 'user-1' }, admin: { userId: 'user-1', role } }
	};
}

/** The load result shape the assertions read (PageServerLoad may also be void). */
interface StoragePageData {
	editable: boolean;
	allowPrivateEndpoint: boolean;
	statusMatchesActive: boolean;
	statusMatchesCandidate: boolean;
	limits: { maxBytes: number; maxBatch: number; rateLimit: number; rateWindowSeconds: number };
	fileCount: number;
	migrationRequired: boolean;
	active: { endpoint: string | null; bucket: string | null; label: string };
	credentials: {
		source: 'db' | 'env' | 'missing' | 'unavailable';
		accessHint: string | null;
		secretHint: string | null;
		keyVersion: number | null;
		envNames: { accessKeyId: string; secretAccessKey: string };
	};
	database: {
		mode: 'local' | 'external';
		host: string;
		port: string | null;
		database: string;
		sslMode: string | null;
		migrations: {
			applied: number;
			latestAt: string | null;
			upToDate: boolean | null;
			expected: number | null;
		};
	} | null;
	envRefs: { accessKey: 'set' | 'missing' };
}

async function loadData(event: ReturnType<typeof makeEvent>): Promise<StoragePageData> {
	return (await load(event as never)) as unknown as StoragePageData;
}

function call(
	action: 'saveProvider' | 'savePurge' | 'testProvider' | 'saveCredentials' | 'clearCredentials',
	event: ReturnType<typeof makeEvent>
) {
	return (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[action](
		event as never
	);
}

const S3_FIELDS = {
	driver: 's3',
	providerType: 'minio',
	// An IP literal keeps the save path off DNS: the guard classifies it directly.
	endpoint: 'https://93.184.216.34',
	region: 'us-east-1',
	bucket: 'lair-media',
	forcePathStyle: 'on',
	publicBaseUrl: ''
};

describe('storage settings route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.provider = {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		};
		state.fileCount = 0;
		state.status.fingerprint = null;
	});

	it('marks the page editable for the owner only', async () => {
		const owner = await loadData(makeEvent({}, 'owner'));
		expect(owner.editable).toBe(true);
		expect(owner.limits.maxBatch).toBe(10);

		const admin = await loadData(makeEvent({}, 'admin'));
		expect(admin.editable).toBe(false);
	});

	it('reports the live env addressing and the env credential reference', async () => {
		const data = await loadData(makeEvent());
		expect(data.active.endpoint).toBe('http://127.0.0.1:9000');
		expect(data.active.bucket).toBe('web-lair');
		expect(data.active.label).toBe('local');
		// External credentials are not configured in this fixture.
		expect(data.credentials.source).toBe('missing');
		expect(data.credentials.envNames.accessKeyId).toBe('STORAGE_S3_ACCESS_KEY');
		expect(data.envRefs.accessKey).toBe('set');
	});

	it('shows the database read-only facts with a masked host', async () => {
		const data = await loadData(makeEvent());

		expect(data.database).toMatchObject({
			mode: 'external',
			host: 'db.…',
			port: '5432',
			database: 'lair',
			migrations: { applied: expect.any(Number), upToDate: true }
		});
		// The connection string's password never reaches page data.
		expect(JSON.stringify(data.database)).not.toContain('db-password');
	});

	it('requires a migration only when the candidate is a different target', async () => {
		await expect(loadData(makeEvent())).resolves.toMatchObject({
			fileCount: 0,
			migrationRequired: false
		});
		// Files exist but the candidate equals the live config: nothing to move.
		state.fileCount = 3;
		await expect(loadData(makeEvent())).resolves.toMatchObject({
			fileCount: 3,
			migrationRequired: false
		});
		// A different addressing target now needs the copy.
		state.provider = {
			driver: 's3',
			providerType: 'minio',
			endpoint: 'https://93.184.216.34',
			region: 'us-east-1',
			bucket: 'lair-media',
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		};
		await expect(loadData(makeEvent())).resolves.toMatchObject({
			fileCount: 3,
			migrationRequired: true
		});
	});

	it('saves the candidate only and never touches storage.active', async () => {
		const result = await call('saveProvider', makeEvent(S3_FIELDS));

		expect(result).toMatchObject({ step: 'provider', ok: true });
		expect(state.setOption).toHaveBeenCalledTimes(1);
		expect(state.setOption).toHaveBeenCalledWith(
			'storage.provider',
			expect.objectContaining({
				driver: 's3',
				providerType: 'minio',
				endpoint: 'https://93.184.216.34',
				bucket: 'lair-media',
				forcePathStyle: true
			})
		);
		const written = state.setOption.mock.calls.map((call) => (call as unknown[])[0]);
		expect(written).not.toContain('storage.active');
		expect(state.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ event: 'storage.provider_update', deliver: false })
		);
	});

	it('rejects a non-owner write before touching the store', async () => {
		await expect(call('saveProvider', makeEvent(S3_FIELDS, 'admin'))).rejects.toMatchObject({
			status: 403
		});
		expect(state.setOption).not.toHaveBeenCalled();
	});

	it('rejects a half-configured external provider with a field error', async () => {
		const noBucket = await call('saveProvider', makeEvent({ ...S3_FIELDS, bucket: '' }));
		expect(noBucket).toMatchObject({ status: 400, data: { step: 'provider', ok: false } });

		const plainHttp = await call(
			'saveProvider',
			makeEvent({ ...S3_FIELDS, endpoint: 'http://s3.example.com' })
		);
		expect(plainHttp).toMatchObject({ status: 400, data: { step: 'provider', ok: false } });

		const r2Region = await call(
			'saveProvider',
			makeEvent({ ...S3_FIELDS, providerType: 'r2', region: 'us-east-1' })
		);
		expect(r2Region).toMatchObject({ status: 400, data: { step: 'provider', ok: false } });

		expect(state.setOption).not.toHaveBeenCalled();
	});

	it('rejects a private or metadata endpoint at SAVE time (not only at probe time)', async () => {
		for (const endpoint of ['https://192.168.1.10', 'https://169.254.169.254']) {
			state.setOption.mockClear();
			const result = await call('saveProvider', makeEvent({ ...S3_FIELDS, endpoint }));
			expect(result, endpoint).toMatchObject({
				status: 400,
				data: { step: 'provider', ok: false }
			});
			expect(state.setOption, endpoint).not.toHaveBeenCalled();
		}
	});

	it('rejects a form without a valid driver instead of coercing it to local', async () => {
		state.setOption.mockClear();
		const result = await call('saveProvider', makeEvent({ driver: 'gopher' }));
		expect(result).toMatchObject({ status: 400, data: { step: 'provider', ok: false } });
		expect(state.setOption).not.toHaveBeenCalled();
	});

	it('refuses a local provider that smuggles external addressing', async () => {
		// A stale form post (driver=local with s3 fields) must save a local
		// provider with null addressing — never a local row carrying a bucket.
		const result = await call(
			'saveProvider',
			makeEvent({ driver: 'local', endpoint: 'https://93.184.216.34', bucket: 'lair-media' })
		);
		expect(result).toMatchObject({ step: 'provider', ok: true });
		expect(state.setOption).toHaveBeenCalledWith(
			'storage.provider',
			expect.objectContaining({
				driver: 'local',
				providerType: null,
				endpoint: null,
				bucket: null
			})
		);
	});

	it('keeps the 1-day floor on purge TTLs', async () => {
		const bad = await call('savePurge', makeEvent({ pendingDays: '0', detachedDays: '30' }));
		expect(bad).toMatchObject({ status: 400, data: { step: 'purge', ok: false } });

		const badFraction = await call(
			'savePurge',
			makeEvent({ pendingDays: '7', detachedDays: '1.5' })
		);
		expect(badFraction).toMatchObject({ status: 400, data: { step: 'purge', ok: false } });
		expect(state.setOption).not.toHaveBeenCalled();

		const ok = await call('savePurge', makeEvent({ pendingDays: '7', detachedDays: '30' }));
		expect(ok).toMatchObject({ step: 'purge', ok: true });
		expect(state.setOption).toHaveBeenCalledWith('media.purge', {
			pendingDays: 7,
			detachedDays: 30
		});
	});
});

describe('storage connection test', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.provider = {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		};
		state.probeResult = {
			ok: true,
			status: 'ok',
			message: '',
			latencyMs: 12,
			checkedAt: '2026-11-14T12:00:00.000Z',
			versioning: 'off',
			objectLock: false
		};
	});

	it('is owner-only', async () => {
		await expect(call('testProvider', makeEvent({}, 'admin'))).rejects.toMatchObject({
			status: 403
		});
		expect(state.setOption).not.toHaveBeenCalled();
	});

	it('stores a sanitized success status and audits storage.test', async () => {
		const result = await call('testProvider', makeEvent());

		expect(result).toMatchObject({ step: 'test', ok: true });
		expect(state.setOption).toHaveBeenCalledWith(
			'storage.status',
			expect.objectContaining({
				lastTestOk: true,
				lastStatus: 'ok',
				lastError: null,
				bucketVersioning: 'off',
				objectLock: false
			})
		);
		expect(state.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ event: 'storage.test', deliver: false })
		);
	});

	it('records a failed probe and answers 502', async () => {
		state.probeResult = {
			...state.probeResult,
			ok: false,
			status: 'auth',
			message: 'storage headBucket failed: HTTP 403 (AccessDenied)'
		};

		const result = await call('testProvider', makeEvent());

		expect(result).toMatchObject({ status: 502, data: { step: 'test', ok: false } });
		expect(state.setOption).toHaveBeenCalledWith(
			'storage.status',
			expect.objectContaining({
				lastTestOk: false,
				lastStatus: 'auth',
				lastError: expect.stringContaining('HTTP 403')
			})
		);
	});

	it('refuses an external provider without credentials and records why', async () => {
		state.provider = {
			driver: 's3',
			providerType: 'custom',
			endpoint: 'https://93.184.216.34',
			region: 'us-east-1',
			bucket: 'lair-media',
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		};

		const result = await call('testProvider', makeEvent());

		expect(result).toMatchObject({ status: 400, data: { step: 'test', ok: false } });
		expect(state.setOption).toHaveBeenCalledWith(
			'storage.status',
			expect.objectContaining({ lastTestOk: false, lastStatus: 'unknown' })
		);
		// The reason names the env vars, never a value.
		const stored = state.setOption.mock.calls.at(-1)?.[1] as { lastError?: string };
		expect(stored.lastError ?? '').toContain('STORAGE_S3_ACCESS_KEY');
	});

	it('rejects a metadata endpoint at probe time even for a saved row', async () => {
		state.provider = {
			driver: 's3',
			providerType: 'custom',
			endpoint: 'https://169.254.169.254',
			region: 'us-east-1',
			bucket: 'lair-media',
			forcePathStyle: true,
			publicBaseUrl: null,
			deleteMode: 'hard'
		};

		const result = await call('testProvider', makeEvent());

		expect(result).toMatchObject({ status: 400, data: { step: 'test', ok: false } });
	});
});

describe('storage credentials', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.credentialStatus = {
			source: 'missing',
			accessHint: null,
			secretHint: null,
			keyVersion: null,
			updatedAt: null
		};
		state.credentialError = null;
		state.savedCredentials = null;
	});

	it('load exposes hints and never a plaintext value', async () => {
		state.credentialStatus = {
			source: 'db',
			accessHint: 'AKIA…MPLE',
			secretHint: 'wJal…MPLE',
			keyVersion: 2,
			updatedAt: new Date('2026-11-14T10:00:00.000Z')
		};

		const data = await loadData(makeEvent());

		expect(data.credentials).toMatchObject({
			source: 'db',
			accessHint: 'AKIA…MPLE',
			secretHint: 'wJal…MPLE',
			keyVersion: 2
		});
		// Hints only: the env VAR NAMES may appear, no credential value can.
		expect(JSON.stringify(data.credentials)).not.toContain('wJalrXUtnFEMI/K7MDENG');
		expect(JSON.stringify(data.credentials)).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});

	it('is owner-only for both write actions', async () => {
		await expect(call('saveCredentials', makeEvent({}, 'admin'))).rejects.toMatchObject({
			status: 403
		});
		await expect(call('clearCredentials', makeEvent({}, 'admin'))).rejects.toMatchObject({
			status: 403
		});
		expect(state.savedCredentials).toBeNull();
	});

	it('saves the pair and audits the rotation without values', async () => {
		const result = await call(
			'saveCredentials',
			makeEvent({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' })
		);

		expect(result).toMatchObject({ step: 'credentials', ok: true });
		expect(state.savedCredentials).toEqual({
			accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
			secretAccessKey: 'wJalrXUtnFEMI/K7MDENG'
		});
		const audit = state.recordActivity.mock.calls.at(-1)?.[1] as {
			event: string;
			payload: Record<string, unknown>;
		};
		expect(audit.event).toBe('storage.update');
		expect(audit.payload).toMatchObject({ action: 'credentials_set', key_version: 1 });
		expect(JSON.stringify(audit.payload)).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(JSON.stringify(audit.payload)).not.toContain('wJalrXUtnFEMI');
	});

	it('maps an input error to 400 and a store failure to 503', async () => {
		const { StorageCredentialError } = await import('$lib/server/secrets/storage-credentials');
		state.credentialError = new StorageCredentialError('missing', 'Both fields are required');
		const invalid = await call(
			'saveCredentials',
			makeEvent({ accessKeyId: '', secretAccessKey: '' })
		);
		expect(invalid).toMatchObject({ status: 400, data: { step: 'credentials', ok: false } });

		state.credentialError = new Error('keyring missing');
		const unavailable = await call(
			'saveCredentials',
			makeEvent({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret-value' })
		);
		expect(unavailable).toMatchObject({ status: 503, data: { step: 'credentials', ok: false } });
	});

	it('clears the stored pair and audits it', async () => {
		const result = await call('clearCredentials', makeEvent());

		expect(result).toMatchObject({ step: 'credentials', ok: true });
		const audit = state.recordActivity.mock.calls.at(-1)?.[1] as {
			payload: Record<string, unknown>;
		};
		expect(audit.payload).toMatchObject({ action: 'credentials_clear' });
	});
});

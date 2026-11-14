import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storage control plane, route level (W7.2): the tier gate decides who may
 * write, Save persists ONLY the candidate row (never `storage.active`), the
 * schema rejects a half-configured external provider before anything is
 * written, and the purge form keeps the 1-day floor.
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
		publicBaseUrl: null as string | null
	},
	active: {
		config: {
			driver: 'local' as const,
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null
		},
		previous: null as unknown,
		activatedAt: null as string | null,
		activatedBy: null as string | null
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

vi.mock('$env/dynamic/private', () => ({
	env: {
		RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
		RUSTFS_BUCKET: 'web-lair',
		RUSTFS_ACCESS_KEY: 'local-key',
		RUSTFS_SECRET_KEY: 'local-secret',
		STORAGE_S3_ACCESS_KEY: '',
		STORAGE_S3_SECRET_KEY: ''
	}
}));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: state.guard }));
vi.mock('$lib/server/db', () => ({
	db: { $count: vi.fn(async () => state.fileCount), insert: vi.fn() }
}));
vi.mock('$lib/server/db/content', () => ({ files: { __table: 'files' } }));
vi.mock('$lib/server/audit', () => ({ recordActivity: state.recordActivity }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (key === 'storage.provider') return state.provider;
		if (key === 'storage.active') return state.active;
		if (key === 'storage.status') return state.status;
		if (key === 'media.purge') return state.purge;
		throw new Error(`unexpected option ${key}`);
	}),
	setOption: state.setOption
}));

import { actions, load, providerFromForm } from './+page.server';

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
	ownerOnly: boolean;
	allowPrivateEndpoint: boolean;
	fileCount: number;
	migrationRequired: boolean;
	active: { endpoint: string | null; bucket: string | null; label: string };
	credentials: {
		source: 'env' | 'missing';
		envNames: { accessKeyId: string; secretAccessKey: string };
	};
	envRefs: { accessKey: 'set' | 'missing' };
}

async function loadData(event: ReturnType<typeof makeEvent>): Promise<StoragePageData> {
	return (await load(event as never)) as unknown as StoragePageData;
}

function call(
	action: 'saveProvider' | 'savePurge' | 'testProvider',
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

describe('storage settings route (W7.2)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.provider = {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null
		};
		state.fileCount = 0;
		state.status.fingerprint = null;
	});

	it('marks the page editable for the owner only', async () => {
		const owner = await loadData(makeEvent({}, 'owner'));
		expect(owner.editable).toBe(true);
		expect(owner.ownerOnly).toBe(false);

		const admin = await loadData(makeEvent({}, 'admin'));
		expect(admin.editable).toBe(false);
		expect(admin.ownerOnly).toBe(true);
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

	it('turns the files count into the migration requirement', async () => {
		await expect(loadData(makeEvent())).resolves.toMatchObject({
			fileCount: 0,
			migrationRequired: false
		});
		state.fileCount = 3;
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

	it('refuses a local provider that smuggles external addressing', () => {
		const form = new FormData();
		form.set('driver', 'local');
		form.set('endpoint', 'https://s3.example.com');
		form.set('bucket', 'lair-media');
		const parsed = providerFromForm(form);
		expect(parsed.driver).toBe('local');
		expect(parsed.endpoint).toBeNull();
		expect(parsed.bucket).toBeNull();
		expect(parsed.providerType).toBeNull();
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

describe('storage connection test (W7.3)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.provider = {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: null
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
			publicBaseUrl: null
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
			publicBaseUrl: null
		};

		const result = await call('testProvider', makeEvent());

		expect(result).toMatchObject({ status: 400, data: { step: 'test', ok: false } });
	});
});

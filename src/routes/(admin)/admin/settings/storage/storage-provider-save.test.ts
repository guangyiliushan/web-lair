import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storage control plane, route level (W7.2): the tier gate decides who may
 * write, Save persists ONLY the candidate row (never `storage.active`), the
 * schema rejects a half-configured external provider before anything is
 * written, and the purge form keeps the 1-day floor.
 */
const state = vi.hoisted(() => ({
	provider: {
		driver: 'local' as const,
		providerType: null,
		endpoint: null,
		region: 'us-east-1',
		bucket: null,
		forcePathStyle: true,
		publicBaseUrl: null
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
	setOption: vi.fn(async () => {}),
	recordActivity: vi.fn(async () => {}),
	guard: vi.fn(async () => {})
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

function call(action: 'saveProvider' | 'savePurge', event: ReturnType<typeof makeEvent>) {
	return (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[action](
		event as never
	);
}

const S3_FIELDS = {
	driver: 's3',
	providerType: 'minio',
	endpoint: 'https://s3.example.com',
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
		const owner = await load(makeEvent({}, 'owner') as never);
		expect(owner.editable).toBe(true);
		expect(owner.ownerOnly).toBe(false);

		const admin = await load(makeEvent({}, 'admin') as never);
		expect(admin.editable).toBe(false);
		expect(admin.ownerOnly).toBe(true);
	});

	it('reports the live env addressing and the env credential reference', async () => {
		const data = await load(makeEvent() as never);
		expect(data.active.endpoint).toBe('http://127.0.0.1:9000');
		expect(data.active.bucket).toBe('web-lair');
		expect(data.active.label).toBe('local');
		// External credentials are not configured in this fixture.
		expect(data.credentials.source).toBe('missing');
		expect(data.credentials.envNames.accessKeyId).toBe('STORAGE_S3_ACCESS_KEY');
		expect(data.envRefs.accessKey).toBe('set');
	});

	it('turns the files count into the migration requirement', async () => {
		await expect(load(makeEvent() as never)).resolves.toMatchObject({
			fileCount: 0,
			migrationRequired: false
		});
		state.fileCount = 3;
		await expect(load(makeEvent() as never)).resolves.toMatchObject({
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
				endpoint: 'https://s3.example.com',
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

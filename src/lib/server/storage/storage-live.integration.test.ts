import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest } from './signature';
import { S3Storage } from './s3';
import { copyObjects, enumerateMigrationObjects, planMigration } from './migrate';
import type { S3StorageConfig } from './config';
import { policyAllowsDelete } from '../services/files';

/**
 * Live S3-dialect proof against the bundled RustFS, addressed exactly
 * the way an EXTERNAL provider is addressed (driver=s3 shape: path style,
 * explicit bucket, SigV4 credentials). Everything here is real HTTP against a
 * real S3 implementation — no fetch fakes.
 *
 * Skipped unless STORAGE_LIVE=1 (and the RUSTFS_* variables are present), so
 * the default unit run stays offline. Run with:
 *
 *   STORAGE_LIVE=1 pnpm test:storage-live
 *
 * Covers: the four verbs + HEAD/404 semantics, the capability reads the purge
 * guard depends on (off -> enabled), and a full migration from one bucket to
 * another with hash verification and resume.
 */
const ENDPOINT = process.env.RUSTFS_ENDPOINT?.replace(/\/+$/, '');
const ACCESS = process.env.RUSTFS_ACCESS_KEY;
const SECRET = process.env.RUSTFS_SECRET_KEY;
// Runs whenever the RUSTFS_* variables are present (the dedicated script loads
// .env); the offline unit run has none and skips. STORAGE_LIVE=0 opts out.
const LIVE = process.env.STORAGE_LIVE !== '0' && Boolean(ENDPOINT && ACCESS && SECRET);
// Per-run bucket names: a crashed earlier run must not poison this one with
// leftover objects (a fixed name made plan.pending assertion flaky).
const RUN = Date.now().toString(36);
const SOURCE_BUCKET = `wl-live-source-${RUN}`;
const TARGET_BUCKET = `wl-live-target-${RUN}`;
const VERSIONED_BUCKET = `wl-live-versioned-${RUN}`;

function configFor(bucket: string): S3StorageConfig {
	if (!ENDPOINT || !ACCESS || !SECRET) throw new Error('RUSTFS_* is not set');
	return {
		endpoint: ENDPOINT,
		bucket,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET }
	};
}

/** Raw signed request, for verbs the adapter does not expose (bucket ops). */
async function signed(
	method: string,
	bucket: string,
	query = '',
	body?: Uint8Array
): Promise<Response> {
	const url = new URL(`/${bucket}${query ? `?${query}` : ''}`, ENDPOINT);
	const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
	const headers: Array<[string, string]> = [
		['host', url.host],
		['x-amz-content-sha256', payloadHash]
	];
	const signedRequest = signRequest(
		{
			method,
			canonicalUri: `/${bucket}`,
			query,
			headers,
			payloadHash,
			region: 'us-east-1',
			service: 's3',
			date: new Date()
		},
		{ accessKeyId: ACCESS!, secretAccessKey: SECRET! }
	);
	const requestHeaders = new Headers();
	for (const [name, value] of signedRequest.headers) requestHeaders.append(name, value);
	// TS 5.7 distinguishes ArrayBufferLike-backed views; fetch wants the plain
	// ArrayBuffer form, so hand it a copy's buffer.
	const payload = body ? new Uint8Array(body).buffer : undefined;
	return fetch(url, { method, headers: requestHeaders, body: payload });
}

/** Best-effort teardown: a leftover bucket must not fail the suite. */
async function dropBucket(bucket: string, keys: string[] = []): Promise<void> {
	const storage = new S3Storage(configFor(bucket));
	for (const key of keys) {
		await storage.delete(key).catch(() => {});
	}
	await signed('DELETE', bucket).catch(() => {});
}

describe.skipIf(!LIVE)('live S3 dialect against the bundled RustFS', () => {
	const roundtripKey = 'aa/' + 'aa'.padEnd(64, '3') + '.webp';

	beforeAll(async () => {
		expect(ENDPOINT, 'RUSTFS_ENDPOINT').toBeTruthy();
		for (const bucket of [SOURCE_BUCKET, TARGET_BUCKET, VERSIONED_BUCKET]) {
			await new S3Storage(configFor(bucket)).ensureBucket();
		}
	});

	afterAll(async () => {
		await dropBucket(SOURCE_BUCKET, [roundtripKey]);
		await dropBucket(TARGET_BUCKET);
		await dropBucket(VERSIONED_BUCKET);
	});

	it('roundtrips an object through the external-driver shape', async () => {
		const storage = new S3Storage(configFor(SOURCE_BUCKET));
		const payload = new TextEncoder().encode('live s3 body');

		await storage.put(roundtripKey, payload, { contentType: 'image/webp' });
		const head = await storage.head(roundtripKey);
		expect(head?.byteSize).toBe(payload.byteLength);
		expect(head?.contentType).toBe('image/webp');

		const object = await storage.get(roundtripKey);
		expect(object).not.toBeNull();
		expect(new TextDecoder().decode(await new Response(object!.body).arrayBuffer())).toBe(
			'live s3 body'
		);

		await storage.delete(roundtripKey);
		expect(await storage.head(roundtripKey)).toBeNull();
		// Idempotent delete of a missing object.
		await expect(storage.delete(roundtripKey)).resolves.toBeUndefined();
	});

	it('reads capabilities off a bucket, then after versioning is enabled', async () => {
		const storage = new S3Storage(configFor(VERSIONED_BUCKET));

		await expect(storage.bucketCapabilities()).resolves.toEqual({
			versioning: 'off',
			objectLock: false
		});

		const enable = await signed(
			'PUT',
			VERSIONED_BUCKET,
			'versioning',
			new TextEncoder().encode(
				'<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'
			)
		);
		expect(enable.ok, `enable versioning: HTTP ${enable.status}`).toBe(true);

		const capabilities = await storage.bucketCapabilities();
		expect(capabilities.versioning).toBe('enabled');
		// The deletion contract now refuses a hard delete:
		expect(policyAllowsDelete({ ...capabilities, deleteMode: 'hard' })).toBe(false);
		expect(policyAllowsDelete({ ...capabilities, deleteMode: 'logical' })).toBe(true);
	});

	it('migrates objects between two buckets with hash verification and resume', async () => {
		const source = new S3Storage(configFor(SOURCE_BUCKET));
		const target = new S3Storage(configFor(TARGET_BUCKET));

		const bodyA = new TextEncoder().encode('first object bytes');
		const bodyB = new TextEncoder().encode('second object bytes');
		const realKeyA = 'bb/' + sha256Hex(bodyA) + '.webp';
		const realKeyB = 'cc/' + sha256Hex(bodyB) + '.jpg';
		const variantA = `${realKeyA}@thumb`;

		await source.put(realKeyA, bodyA, { contentType: 'image/webp' });
		await source.put(realKeyB, bodyB, { contentType: 'image/jpeg' });
		await source.put(variantA, new TextEncoder().encode('thumb bytes'));

		const objects = enumerateMigrationObjects([
			{ objectKey: realKeyA, contentHash: sha256Hex(bodyA), byteSize: bodyA.byteLength },
			{ objectKey: realKeyB, contentHash: sha256Hex(bodyB), byteSize: bodyB.byteLength }
		]);

		const plan = await planMigration(objects, { source, target });
		expect(plan.missingOnSource).toEqual([]);
		expect(plan.total).toBe(10); // 2 canonical + 8 variants
		expect(plan.pending).toBe(10);

		const first = await copyObjects(objects, { source, target });
		expect(first.copied).toBe(3);
		expect(first.verified).toBe(3);
		// Variants the source never had are skipped, not failed: otherwise any
		// site with an attachment could never cut over (missing VARIANT ≠
		// missing canonical object).
		expect(first.failed).toEqual([]);
		expect(first.missingVariants).toBe(7);

		// Resume: the three present objects verify without a rewrite.
		const second = await copyObjects(objects, { source, target });
		expect(second.copied).toBe(0);
		expect(second.skipped).toBe(3);
		expect(second.verified).toBe(3);

		// The bytes really match on the target.
		const copied = await target.get(realKeyA);
		expect(new TextDecoder().decode(await new Response(copied!.body).arrayBuffer())).toBe(
			'first object bytes'
		);

		// Teardown of this test's objects (the bucket itself goes in afterAll).
		for (const key of [realKeyA, realKeyB, variantA]) {
			await source.delete(key).catch(() => {});
			await target.delete(key).catch(() => {});
		}
	});
});

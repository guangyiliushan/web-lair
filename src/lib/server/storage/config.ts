import type { SigV4Credentials } from './signature';

/**
 * S3-dialect connection settings (W7.1). One shape for both drivers: the
 * bundled RustFS (`driver=local`) and any external S3-compatible provider
 * (`driver=s3`, decision Q2). `forcePathStyle` is the only addressing switch —
 * `true` sends `endpoint/bucket/key` (RustFS, MinIO), `false` sends
 * `bucket.endpoint/key` (AWS S3, Cloudflare R2).
 */
export interface S3StorageConfig {
	endpoint: string;
	bucket: string;
	region: string;
	credentials: SigV4Credentials;
	forcePathStyle: boolean;
}

/** SigV4 region for the single-node RustFS deployment (ledger §21). */
export const DEFAULT_RUSTFS_REGION = 'us-east-1';

/**
 * Reject an endpoint that cannot be a signed S3 URL: only http(s), never a
 * URL carrying credentials (`https://key:secret@host` would leak into logs and
 * into the signed host). The allow-private decision belongs to the caller —
 * the local driver must reach loopback, an external one must not.
 */
export function assertStorageEndpoint(endpoint: string, source: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`${source}: endpoint is not a URL`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`${source}: endpoint must be http(s), got ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error(`${source}: endpoint must not embed credentials`);
	}
	return endpoint.replace(/\/+$/, '');
}

/**
 * Builds the LOCAL (RustFS) storage config from an env-like record. Used by
 * both the SvelteKit runtime (`$env/dynamic/private`) and plain scripts
 * (`process.env`). Throws on missing keys so misconfiguration surfaces loudly
 * at the first storage call instead of as a signed-request 403.
 *
 * Name kept for the storage-line scripts and tests that predate the driver
 * split (W7.1); behaviour is unchanged.
 */
export function storageConfigFromEnv(source: Record<string, string | undefined>): S3StorageConfig {
	const rawEndpoint = source.RUSTFS_ENDPOINT?.trim();
	const accessKeyId = source.RUSTFS_ACCESS_KEY?.trim();
	const secretAccessKey = source.RUSTFS_SECRET_KEY?.trim();
	const bucket = source.RUSTFS_BUCKET?.trim();
	const missing = [
		['RUSTFS_ENDPOINT', rawEndpoint],
		['RUSTFS_ACCESS_KEY', accessKeyId],
		['RUSTFS_SECRET_KEY', secretAccessKey],
		['RUSTFS_BUCKET', bucket]
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`Storage config incomplete (ledger §21): missing ${missing.join(', ')}`);
	}
	return {
		endpoint: assertStorageEndpoint(rawEndpoint!, 'RUSTFS_ENDPOINT'),
		bucket: bucket!,
		region: DEFAULT_RUSTFS_REGION,
		forcePathStyle: true,
		credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }
	};
}

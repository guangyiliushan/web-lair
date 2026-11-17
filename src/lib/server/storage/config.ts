import type { SigV4Credentials } from './signature';
import type { StorageProviderConfig } from './provider';

/**
 * S3-dialect connection settings. One shape for both drivers: the
 * bundled RustFS (`driver=local`) and any external S3-compatible provider
 * (`driver=s3`). `forcePathStyle` is the only addressing switch —
 * `true` sends `endpoint/bucket/key` (RustFS, MinIO), `false` sends
 * `bucket.endpoint/key` (AWS S3 and other virtual-hosted providers).
 */
export interface S3StorageConfig {
	endpoint: string;
	bucket: string;
	region: string;
	credentials: SigV4Credentials;
	forcePathStyle: boolean;
}

/** SigV4 region for the single-node RustFS deployment. */
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
 * split; behaviour is unchanged.
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

/** Env names the external driver reads; the page shows them, never the values. */
export const S3_CREDENTIAL_ENV = {
	accessKeyId: 'STORAGE_S3_ACCESS_KEY',
	secretAccessKey: 'STORAGE_S3_SECRET_KEY'
} as const;

/**
 * External S3 credentials from the environment. Missing
 * or partial pairs resolve null - the caller decides whether that is a
 * "not configured" state (the page) or a hard failure (the runtime). Values
 * are never logged, echoed into errors, or copied into an option row.
 */
export function providerCredentialsFromEnv(
	source: Record<string, string | undefined>
): SigV4Credentials | null {
	const accessKeyId = source[S3_CREDENTIAL_ENV.accessKeyId]?.trim();
	const secretAccessKey = source[S3_CREDENTIAL_ENV.secretAccessKey]?.trim();
	if (!accessKeyId || !secretAccessKey) return null;
	return { accessKeyId, secretAccessKey };
}

/**
 * Builds the adapter config for a provider shape. The local driver
 * keeps reading RUSTFS_*; the external driver takes its addressing from the
 * stored provider and its credentials from whatever the caller resolved
 * (env today, an encrypted store later).
 */
export function storageConfigForProvider(
	provider: StorageProviderConfig,
	options: {
		source: Record<string, string | undefined>;
		credentials?: SigV4Credentials | null;
	}
): S3StorageConfig {
	if (provider.driver === 'local') return storageConfigFromEnv(options.source);

	const credentials = options.credentials ?? providerCredentialsFromEnv(options.source);
	if (!credentials) {
		throw new Error(
			`External storage credentials are not configured (set ${S3_CREDENTIAL_ENV.accessKeyId} and ${S3_CREDENTIAL_ENV.secretAccessKey})`
		);
	}
	if (!provider.endpoint || !provider.bucket) {
		throw new Error('External storage provider is incomplete (endpoint and bucket are required)');
	}
	return {
		endpoint: assertStorageEndpoint(provider.endpoint, 'storage.provider.endpoint'),
		bucket: provider.bucket,
		region: provider.region,
		forcePathStyle: provider.forcePathStyle,
		credentials
	};
}

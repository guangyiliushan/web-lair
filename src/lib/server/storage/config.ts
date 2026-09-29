import type { SigV4Credentials } from './signature';

export interface RustFsConfig {
	endpoint: string;
	bucket: string;
	region: string;
	credentials: SigV4Credentials;
}

/** SigV4 region for the single-node RustFS deployment (ledger §21). */
export const DEFAULT_RUSTFS_REGION = 'us-east-1';

/**
 * Builds the storage config from an env-like record. Used by both the
 * SvelteKit runtime (`$env/dynamic/private`) and plain scripts
 * (`process.env`). Throws on missing keys so misconfiguration surfaces
 * loudly at the first storage call instead of as a signed-request 403.
 */
export function storageConfigFromEnv(source: Record<string, string | undefined>): RustFsConfig {
	const endpoint = source.RUSTFS_ENDPOINT?.trim();
	const accessKeyId = source.RUSTFS_ACCESS_KEY?.trim();
	const secretAccessKey = source.RUSTFS_SECRET_KEY?.trim();
	const bucket = source.RUSTFS_BUCKET?.trim();
	const missing = [
		['RUSTFS_ENDPOINT', endpoint],
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
		endpoint: endpoint!.replace(/\/+$/, ''),
		bucket: bucket!,
		region: DEFAULT_RUSTFS_REGION,
		credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }
	};
}

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { resolveStorageCredentials } from '$lib/server/secrets/storage-credentials';
import { storageConfigForProvider } from './config';
import { S3Storage } from './s3';
import { readActiveProvider } from './active';
import { StorageError, type ObjectStoragePort } from './port';
import type { StorageActive, StorageProviderConfig } from './provider';
import type { SigV4Credentials } from './signature';

/**
 * getStorage: the runtime storage handle, built from the ACTIVE provider
 * (`storage.active`), never the saved form - that is what makes "Save only
 * saves, it does not switch" true at the runtime boundary. The bootstrap
 * default is the bundled RustFS; the read is strict (`active.ts`), so a
 * corrupt row fails closed instead of silently serving the default bucket.
 * No process-wide instance cache: every call resolves the active row (one
 * primary-key read on a tiny table) so a cutover takes effect on the next
 * request in every replica; hot routes resolve once and reuse it per request.
 * Credentials: the local driver needs none; the external driver asks the
 * secret store first, the environment second; a store failure becomes a
 * StorageError (status 0), which the callers' unreachable-provider path
 * (503, no fallback) treats like a dead endpoint.
 */
export async function getStorage(): Promise<ObjectStoragePort> {
	return buildStorageForActive(await readActiveProvider());
}

/** The live provider row (also carries `publicBaseUrl` for the media proxy). */
export async function getActiveProvider(): Promise<StorageActive> {
	return readActiveProvider();
}

/** Builds the handle for an already-read active row (one DB read per request). */
export async function buildStorageForActive(active: StorageActive): Promise<ObjectStoragePort> {
	if (active.config.driver === 'local') return buildStorageForProvider(active.config);
	return buildStorageForProvider(active.config, { credentials: await storageCredentials() });
}

/**
 * Resolved external credentials, or a StorageError when the store exists but
 * cannot be read. `null` (nothing configured) is left to the config builder,
 * whose message names the env vars without values.
 */
export async function storageCredentials(): Promise<SigV4Credentials | null> {
	try {
		const resolved = await resolveStorageCredentials(db as never, {
			getEnv: (name) => env[name]
		});
		return resolved
			? { accessKeyId: resolved.accessKeyId, secretAccessKey: resolved.secretAccessKey }
			: null;
	} catch (error) {
		throw new StorageError(
			`storage credentials unavailable: ${error instanceof Error ? error.name : 'unknown'}`,
			0,
			'SecretStoreUnavailable'
		);
	}
}

/**
 * Builds a handle for an explicit provider shape — used by the connection test
 * (candidate), the migration CLI (source and target) and the runtime.
 * Credentials default to the environment; callers that read the secret store
 * pass the resolved pair.
 */
export function buildStorageForProvider(
	provider: StorageProviderConfig,
	options: {
		source?: Record<string, string | undefined>;
		credentials?: SigV4Credentials | null;
		/** Header-stage timeout; the connection probe keeps this short. */
		headersTimeoutMs?: number;
	} = {}
): ObjectStoragePort {
	const config = storageConfigForProvider(provider, {
		source: options.source ?? env,
		credentials: options.credentials
	});
	return new S3Storage(
		config,
		options.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: options.headersTimeoutMs }
	);
}

import { env } from '$env/dynamic/private';
import { getOption } from '$lib/server/config/options-registry';
import { storageConfigForProvider } from './config';
import { S3Storage } from './s3';
import type { ObjectStoragePort } from './port';
import type { StorageProviderConfig } from './provider';
import type { SigV4Credentials } from './signature';

/**
 * Runtime storage handle (W7.1/W7.2).
 *
 * The adapter is built from the ACTIVE provider (`storage.active`), never from
 * the saved form — that is what makes "Save only saves, it does not switch"
 * true at the runtime boundary, not just in the UI (decision Q4). The bootstrap
 * default is the bundled RustFS, so an install that never touched the page
 * behaves exactly as before.
 *
 * No process-wide instance cache: every call resolves the active row (one
 * primary-key read on a tiny table) so a cutover takes effect on the next
 * request in every replica. Hot routes resolve once and reuse the handle
 * inside the request.
 */
export async function getStorage(): Promise<ObjectStoragePort> {
	const active = await getOption('storage.active');
	return buildStorageForProvider(active.config);
}

/**
 * Builds a handle for an explicit provider shape — used by the connection test
 * (candidate), the migration CLI (source and target) and the runtime.
 * Credentials default to the environment; W7.6 passes decrypted envelopes.
 */
export function buildStorageForProvider(
	provider: StorageProviderConfig,
	options: {
		source?: Record<string, string | undefined>;
		credentials?: SigV4Credentials | null;
	} = {}
): ObjectStoragePort {
	return new S3Storage(
		storageConfigForProvider(provider, {
			source: options.source ?? env,
			credentials: options.credentials
		})
	);
}

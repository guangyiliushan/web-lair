import { getOption } from '../../src/lib/server/config/options-registry';
import { resolveStorageCredentials } from '../../src/lib/server/secrets/storage-credentials';
import { storageConfigForProvider } from '../../src/lib/server/storage/config';
import { S3Storage } from '../../src/lib/server/storage/s3';

/**
 * Builds the storage handle for a CLI script from the ACTIVE provider
 * (`storage.active`) instead of assuming the bundled RustFS (W7.5/W7.6).
 *
 * Every destructive or media-touching script must read the same target the app
 * reads, or a purge/audit after a cutover would inspect the wrong bucket. The
 * local driver never touches the secret store; the external one resolves
 * db-first credentials with the env fallback.
 */
export type RegistryExecutor = NonNullable<Parameters<typeof getOption>[1]>;

export async function activeStorage(
	executor: RegistryExecutor,
	source: NodeJS.ProcessEnv = process.env
): Promise<S3Storage> {
	const active = await getOption('storage.active', executor);
	const credentials =
		active.config.driver === 'local'
			? null
			: await resolveStorageCredentials(executor as never, { getEnv: (name) => source[name] });
	return new S3Storage(storageConfigForProvider(active.config, { source, credentials }));
}

import { env } from '$env/dynamic/private';
import { storageConfigFromEnv } from './config';
import { S3Storage } from './s3';
import type { ObjectStoragePort } from './port';

const GLOBAL_KEY = Symbol.for('web-lair.storage');

/**
 * Lazily-built storage singleton, pinned on globalThis so Vite HMR in dev
 * keeps a single instance (same pattern as the cache module, ledger §21).
 *
 * W7.1: the bundled RustFS is the only driver wired here; W7.2 makes this
 * resolve the ACTIVE provider (local or external) from the options store.
 */
export function getStorage(): ObjectStoragePort {
	const holder = globalThis as unknown as Record<symbol, ObjectStoragePort | undefined>;
	let storage = holder[GLOBAL_KEY];
	if (!storage) {
		storage = new S3Storage(storageConfigFromEnv(env));
		holder[GLOBAL_KEY] = storage;
	}
	return storage;
}

import { env } from '$env/dynamic/private';
import { storageConfigFromEnv } from './config';
import { RustFsStorage } from './rustfs';
import type { ObjectStoragePort } from './port';

const GLOBAL_KEY = Symbol.for('web-lair.storage');

/**
 * Lazily-built storage singleton, pinned on globalThis so Vite HMR in dev
 * keeps a single instance (same pattern as the cache module, ledger §21).
 */
export function getStorage(): ObjectStoragePort {
	const holder = globalThis as unknown as Record<symbol, ObjectStoragePort | undefined>;
	let storage = holder[GLOBAL_KEY];
	if (!storage) {
		storage = new RustFsStorage(storageConfigFromEnv(env));
		holder[GLOBAL_KEY] = storage;
	}
	return storage;
}

import { eq } from 'drizzle-orm';
import { options } from '../db/config/index.ts';
import { DEFAULT_STORAGE_ACTIVE, storageActiveSchema, type StorageActive } from './provider.ts';
import { StorageError } from './port.ts';

/**
 * Strict read of the live provider row.
 * `getOption('storage.active')` falls back to the registry DEFAULT whenever the
 * stored value fails its schema - right for an informational option, wrong for the
 * live storage target, which would silently swap provider:
 * no row      -> the bootstrap default (bundled RustFS), legitimate;
 * valid row   -> that row;
 * invalid row -> StorageError(status 0), so every storage caller's existing
 *                503 path fails closed instead of serving the wrong bucket.
 * The executor is injected for tests; the app db handle is imported lazily so the
 * module stays importable from plain tsx scripts.
 */

export interface ActiveRowQuery {
	select(fields: Record<string, unknown>): {
		from(table: unknown): {
			where(condition: unknown): {
				limit(count: number): Promise<Array<{ value: unknown }>>;
			};
		};
	};
}

async function readRow(executor?: ActiveRowQuery): Promise<Array<{ value: unknown }>> {
	if (executor) {
		return executor
			.select({ value: options.value })
			.from(options)
			.where(eq(options.name, 'storage.active'))
			.limit(1);
	}
	const { db } = await import('$lib/server/db');
	return db
		.select({ value: options.value })
		.from(options)
		.where(eq(options.name, 'storage.active'))
		.limit(1);
}

export async function readActiveProvider(executor?: ActiveRowQuery): Promise<StorageActive> {
	const rows = await readRow(executor);
	if (rows.length === 0) return structuredClone(DEFAULT_STORAGE_ACTIVE);
	const parsed = storageActiveSchema.safeParse(rows[0]?.value);
	if (!parsed.success) {
		console.warn('[storage] storage.active row failed validation; refusing to fall back');
		throw new StorageError(
			'storage.active is invalid; storage is unavailable until the row is fixed',
			0,
			'ActiveConfigInvalid'
		);
	}
	return parsed.data;
}

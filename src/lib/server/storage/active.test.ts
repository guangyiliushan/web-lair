import { describe, expect, it, vi } from 'vitest';
import { readActiveProvider, type ActiveRowQuery } from './active';
import { DEFAULT_STORAGE_ACTIVE, DEFAULT_PROVIDER_CONFIG } from './provider';
import { StorageError } from './port';

/**
 * Strict live-provider read: a MISSING row is the bootstrap
 * default, a VALID row is used as-is, and a row that fails the schema must
 * fail closed instead of silently serving the bundled RustFS (the generic
 * option reader's default would do exactly that).
 */
function executor(rows: unknown[]): ActiveRowQuery {
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => rows.map((value) => ({ value }))
				})
			})
		})
	};
}

const VALID_S3 = {
	config: {
		driver: 's3',
		providerType: 'minio',
		endpoint: 'https://s3.example.com',
		region: 'us-east-1',
		bucket: 'lair-media',
		forcePathStyle: true,
		publicBaseUrl: null,
		deleteMode: 'hard'
	},
	previous: null,
	activatedAt: '2026-11-14T09:00:00.000Z'
};

describe('readActiveProvider', () => {
	it('returns the bootstrap default when no row exists', async () => {
		await expect(readActiveProvider(executor([]))).resolves.toEqual(DEFAULT_STORAGE_ACTIVE);
	});

	it('returns a valid stored row', async () => {
		await expect(readActiveProvider(executor([VALID_S3]))).resolves.toEqual(VALID_S3);
	});

	it('ignores an unknown legacy field on a valid row', async () => {
		const legacy = { ...VALID_S3, activatedBy: 'user-1' };
		await expect(readActiveProvider(executor([legacy]))).resolves.toMatchObject({
			config: VALID_S3.config
		});
	});

	it('fails closed on a corrupt row instead of falling back to the default', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const corrupt = { config: { driver: 'gopher' }, previous: null, activatedAt: null };

		await expect(readActiveProvider(executor([corrupt]))).rejects.toBeInstanceOf(StorageError);
		await expect(readActiveProvider(executor([corrupt]))).rejects.toMatchObject({
			status: 0,
			code: 'ActiveConfigInvalid'
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('keeps the local bootstrap config authoritative when the row says local', async () => {
		const row = {
			config: DEFAULT_PROVIDER_CONFIG,
			previous: null,
			activatedAt: null
		};
		await expect(readActiveProvider(executor([row]))).resolves.toEqual(row);
	});
});
